import { gzipSync } from "node:zlib";
import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeInstanceTypeOfferingsCommand,
  DescribeInstanceTypesCommand,
  DescribeRegionsCommand,
  DescribeSecurityGroupsCommand,
  DescribeVpcsCommand,
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
  type _InstanceType,
  type Instance,
} from "@aws-sdk/client-ec2";
import {
  ProviderApiError,
  type CreateVmRequest,
  type ProviderDefinition,
  type Region,
  type Size,
  type Vm,
  type VmProvider,
  type VmStatus,
} from "../types";

export interface AwsConfig {
  region: string;
  instanceType: string;
  /** "ubuntu-24.04" for Canonical's latest image, or an AMI id. */
  image: string;
}

// Credentials come from the standard AWS chain (AWS_ACCESS_KEY_ID/SECRET,
// AWS_PROFILE, SSO, ...). Because many machines already have AWS credentials
// for other work, the provider is only on when explicitly enabled.
export const aws: ProviderDefinition = {
  name: "aws",
  label: "AWS",
  setupHint: "set AWS_ENABLED=true in .env (credentials from AWS_PROFILE or AWS_ACCESS_KEY_ID/SECRET)",
  isEnabled: (env) => env.AWS_ENABLED === "true",
  fromEnv(env) {
    const config: AwsConfig = {
      region: env.AWS_REGION || "us-east-1",
      instanceType: env.AWS_INSTANCE_TYPE || "t3.medium",
      image: env.AWS_IMAGE || DEFAULT_IMAGE,
    };
    return {
      provider: new AwsProvider(config),
      defaults: { region: config.region, size: config.instanceType, image: config.image },
    };
  },
};

// Instances we manage carry this tag.
const TAG = "agent-vm";
const SECURITY_GROUP = "agent-vm-ssh";
const DEFAULT_IMAGE = "ubuntu-24.04";
const CANONICAL_OWNER = "099720108477";
const UBUNTU_24_04_AMIS = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*";
// The Ubuntu AMI's 8 GB root disk is too small for the agent tools.
const ROOT_DISK_GB = 40;

// EC2 has hundreds of instance types; offer a short list of general-purpose
// x86 ones (the Ubuntu image above is amd64).
const SIZES = [
  "t3.small",
  "t3.medium",
  "t3.large",
  "t3.xlarge",
  "m7i.large",
  "m7i.xlarge",
  "m7i.2xlarge",
  "c7i.large",
  "c7i.xlarge",
];

const REGION_NAMES: Record<string, string> = {
  "us-east-1": "N. Virginia",
  "us-east-2": "Ohio",
  "us-west-1": "N. California",
  "us-west-2": "Oregon",
  "ca-central-1": "Canada Central",
  "eu-west-1": "Ireland",
  "eu-west-2": "London",
  "eu-west-3": "Paris",
  "eu-central-1": "Frankfurt",
  "eu-north-1": "Stockholm",
  "ap-south-1": "Mumbai",
  "ap-southeast-1": "Singapore",
  "ap-southeast-2": "Sydney",
  "ap-northeast-1": "Tokyo",
  "ap-northeast-2": "Seoul",
  "sa-east-1": "São Paulo",
};

const STATUS: Record<string, VmStatus> = {
  pending: "provisioning",
  running: "running",
  stopping: "stopped",
  stopped: "stopped",
};

// AWS ids are only unique within a region, so ours carry it: "us-east-1/i-0abc...".
function vmId(region: string, instanceId: string): string {
  return `${region}/${instanceId}`;
}

function parseVmId(id: string): { region: string; instanceId: string } {
  const [region, instanceId] = id.split("/");
  if (!region || !instanceId) throw new Error(`Not an AWS agent VM id: "${id}"`);
  return { region, instanceId };
}

function toVm(instance: Instance, region: string): Vm {
  const state = instance.State?.Name ?? "unknown";
  return {
    id: vmId(region, instance.InstanceId!),
    name: instance.Tags?.find((t) => t.Key === "Name")?.Value ?? instance.InstanceId!,
    status: STATUS[state] ?? "unknown",
    providerStatus: state,
    region,
    publicIp: instance.PublicIpAddress ?? null,
    createdAt: instance.LaunchTime?.toISOString() ?? new Date().toISOString(),
  };
}

/** AWS EC2, via the AWS SDK. One client per region. */
export class AwsProvider implements VmProvider {
  readonly name = "aws";
  private readonly clients = new Map<string, EC2Client>();
  private enabledRegions?: Promise<string[]>;

  constructor(private readonly config: AwsConfig) {}

  async listVms(): Promise<Vm[]> {
    // Agent VMs may be in any region, so ask each enabled one.
    const regions = await this.regionSlugs();
    const perRegion = await Promise.all(regions.map((region) => this.describeInstances(region)));
    return perRegion.flat();
  }

  async getVm(id: string): Promise<Vm> {
    const { region, instanceId } = parseVmId(id);
    const [vm] = await this.describeInstances(region, [instanceId]);
    if (!vm) throw new ProviderApiError(this.name, 404, `Instance ${instanceId} not found in ${region}`);
    return vm;
  }

  async createVm(request: CreateVmRequest): Promise<Vm> {
    const region = request.region ?? this.config.region;
    const instanceType = request.size ?? this.config.instanceType;
    await this.assertSizeOffered(region, instanceType);
    const [image, securityGroupId] = await Promise.all([
      this.resolveImage(region, request.image ?? this.config.image),
      this.ensureSecurityGroup(region),
    ]);

    const tags = [
      { Key: "Name", Value: request.name },
      { Key: TAG, Value: "true" },
    ];
    const { Instances } = await this.call(region, (ec2) =>
      ec2.send(
        new RunInstancesCommand({
          ImageId: image.id,
          InstanceType: instanceType as _InstanceType,
          MinCount: 1,
          MaxCount: 1,
          // EC2 limits user data to 16 KB; cloud-init accepts it gzipped.
          UserData: gzipSync(request.userData).toString("base64"),
          // A public IP even if the default subnet doesn't assign one.
          NetworkInterfaces: [{ DeviceIndex: 0, AssociatePublicIpAddress: true, Groups: [securityGroupId] }],
          BlockDeviceMappings: [
            {
              DeviceName: image.rootDevice,
              Ebs: { VolumeSize: ROOT_DISK_GB, VolumeType: "gp3", Encrypted: true, DeleteOnTermination: true },
            },
          ],
          // IMDSv2 only, so a compromised process can't trivially fetch credentials.
          MetadataOptions: { HttpTokens: "required", HttpEndpoint: "enabled" },
          TagSpecifications: [
            { ResourceType: "instance", Tags: tags },
            { ResourceType: "volume", Tags: tags },
          ],
        }),
      ),
    );
    return toVm(Instances![0]!, region);
  }

  async deleteVm(id: string): Promise<void> {
    const { region, instanceId } = parseVmId(id);
    await this.call(region, (ec2) => ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] })));
  }

  async listRegions(): Promise<Region[]> {
    return (await this.regionSlugs()).map((slug) => ({ slug, name: REGION_NAMES[slug] ?? slug }));
  }

  async listSizes(region = this.config.region): Promise<Size[]> {
    const offered = await this.offeredSizes(region, SIZES);
    if (offered.length === 0) return [];
    const { InstanceTypes = [] } = await this.call(region, (ec2) =>
      ec2.send(new DescribeInstanceTypesCommand({ InstanceTypes: offered as _InstanceType[] })),
    );
    return InstanceTypes.map((t) => ({
      name: t.InstanceType!,
      vcpus: t.VCpuInfo?.DefaultVCpus ?? 0,
      ramGb: (t.MemoryInfo?.SizeInMiB ?? 0) / 1024,
      diskGb: ROOT_DISK_GB,
      // The EC2 API doesn't return prices; that needs the separate Pricing API.
      priceMonthly: null,
    }));
  }

  async listImages(): Promise<string[]> {
    return [DEFAULT_IMAGE];
  }

  private regionSlugs(): Promise<string[]> {
    this.enabledRegions ??= this.call(this.config.region, (ec2) => ec2.send(new DescribeRegionsCommand({})))
      .then(({ Regions = [] }) => Regions.map((r) => r.RegionName!).sort())
      .catch((err) => {
        this.enabledRegions = undefined;
        throw err;
      });
    return this.enabledRegions;
  }

  private async describeInstances(region: string, instanceIds?: string[]): Promise<Vm[]> {
    const vms: Vm[] = [];
    let NextToken: string | undefined;
    do {
      const page = await this.call(region, (ec2) =>
        ec2.send(
          new DescribeInstancesCommand({
            InstanceIds: instanceIds,
            Filters: [
              { Name: `tag:${TAG}`, Values: ["true"] },
              { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
            ],
            NextToken,
          }),
        ),
      );
      for (const reservation of page.Reservations ?? []) {
        for (const instance of reservation.Instances ?? []) vms.push(toVm(instance, region));
      }
      NextToken = page.NextToken;
    } while (NextToken);
    return vms;
  }

  private async offeredSizes(region: string, sizes: string[]): Promise<string[]> {
    const { InstanceTypeOfferings = [] } = await this.call(region, (ec2) =>
      ec2.send(
        new DescribeInstanceTypeOfferingsCommand({
          LocationType: "region",
          Filters: [{ Name: "instance-type", Values: sizes }],
        }),
      ),
    );
    return InstanceTypeOfferings.map((o) => o.InstanceType!);
  }

  private async assertSizeOffered(region: string, size: string): Promise<void> {
    if ((await this.offeredSizes(region, [size])).length > 0) return;
    throw new Error(`${size} isn't offered in ${region}. Run \`pnpm cli --provider aws sizes --region ${region}\`.`);
  }

  private async resolveImage(region: string, image: string): Promise<{ id: string; rootDevice: string }> {
    const { Images = [] } = await this.call(region, (ec2) =>
      ec2.send(
        new DescribeImagesCommand(
          image === DEFAULT_IMAGE
            ? {
                Owners: [CANONICAL_OWNER],
                Filters: [
                  { Name: "name", Values: [UBUNTU_24_04_AMIS] },
                  { Name: "state", Values: ["available"] },
                ],
              }
            : { ImageIds: [image] },
        ),
      ),
    );
    const latest = Images.sort((a, b) => (b.CreationDate ?? "").localeCompare(a.CreationDate ?? ""))[0];
    if (!latest?.ImageId) throw new Error(`Image "${image}" not found in ${region}`);
    return { id: latest.ImageId, rootDevice: latest.RootDeviceName ?? "/dev/sda1" };
  }

  // Inbound SSH only. The VM's own firewall (ufw) applies on top of this.
  private async ensureSecurityGroup(region: string): Promise<string> {
    const { Vpcs = [] } = await this.call(region, (ec2) =>
      ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: "is-default", Values: ["true"] }] })),
    );
    const vpcId = Vpcs[0]?.VpcId;
    if (!vpcId) {
      throw new Error(`No default VPC in ${region}. Create one with: aws ec2 create-default-vpc --region ${region}`);
    }

    const { SecurityGroups = [] } = await this.call(region, (ec2) =>
      ec2.send(
        new DescribeSecurityGroupsCommand({
          Filters: [
            { Name: "group-name", Values: [SECURITY_GROUP] },
            { Name: "vpc-id", Values: [vpcId] },
          ],
        }),
      ),
    );
    if (SecurityGroups[0]?.GroupId) return SecurityGroups[0].GroupId;

    const { GroupId } = await this.call(region, (ec2) =>
      ec2.send(
        new CreateSecurityGroupCommand({
          GroupName: SECURITY_GROUP,
          Description: "agent-vm: inbound SSH only",
          VpcId: vpcId,
          TagSpecifications: [{ ResourceType: "security-group", Tags: [{ Key: TAG, Value: "true" }] }],
        }),
      ),
    );
    await this.call(region, (ec2) =>
      ec2.send(
        new AuthorizeSecurityGroupIngressCommand({
          GroupId,
          IpPermissions: [
            {
              IpProtocol: "tcp",
              FromPort: 22,
              ToPort: 22,
              IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "ssh" }],
              Ipv6Ranges: [{ CidrIpv6: "::/0", Description: "ssh" }],
            },
          ],
        }),
      ),
    );
    return GroupId!;
  }

  private client(region: string): EC2Client {
    let client = this.clients.get(region);
    if (!client) {
      // The SDK retries throttling errors with backoff (3 attempts by default).
      client = new EC2Client({ region });
      this.clients.set(region, client);
    }
    return client;
  }

  private async call<T>(region: string, request: (ec2: EC2Client) => Promise<T>): Promise<T> {
    try {
      return await request(this.client(region));
    } catch (err) {
      const { name, message } = err as Error;
      throw new ProviderApiError(this.name, name, message);
    }
  }
}
