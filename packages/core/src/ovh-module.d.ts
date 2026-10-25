// Minimal types for the official `ovh` client, which ships without any.
declare module "ovh" {
  interface OvhClientOptions {
    endpoint?: string;
    appKey: string;
    appSecret: string;
    consumerKey?: string;
    timeout?: number;
  }

  interface OvhClient {
    requestPromised<T = unknown>(
      method: string,
      path: string,
      params?: Record<string, unknown>,
    ): Promise<T>;
  }

  export default function ovh(options: OvhClientOptions): OvhClient;
}
