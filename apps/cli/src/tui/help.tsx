import { Box, Text, useInput } from "ink";
import { Modal } from "./ui";

const GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: "This VM",
    keys: [
      ["⏎", "connect over SSH"],
      ["t", "attach tmux"],
      ["g", "open desktop"],
      ["l", "sign in tools"],
      ["s", "sleep / wake"],
      ["a", "auto-sleep on/off"],
      ["b", "snapshot"],
      ["u", "update Convoy setup"],
      ["→", "full details"],
      ["d", "delete"],
    ],
  },
  {
    title: "Fleet",
    keys: [
      ["n", "new VM"],
      ["N", "new, same as last"],
      ["/", "filter by name"],
      ["p", "switch project"],
      ["i", "inspector on/off"],
      ["r", "refresh"],
    ],
  },
  {
    title: "Move",
    keys: [
      ["↑↓ jk", "select"],
      ["1 2 3", "switch tab"],
      ["tab", "next tab"],
      ["esc", "back / close"],
      ["?", "this help"],
      ["q", "quit"],
    ],
  },
];

export function Help({ onClose }: { onClose: () => void }) {
  useInput(() => onClose());
  return (
    <Modal title="Keys" width={86}>
      <Box columnGap={4}>
        {GROUPS.map((group) => (
          <Box key={group.title} flexDirection="column" width={24}>
            <Text bold>{group.title}</Text>
            {group.keys.map(([k, label]) => (
              <Text key={k}>
                <Text bold color="cyan">
                  {k.padEnd(6)}
                </Text>
                {label}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>The bar at the bottom shows only the keys that work for the selected VM.</Text>
        <Text dimColor>
          ● running  ◐ working  ☾ asleep  ○ stopped  ✕ failed  ·  zz 30m: sleeps after 30 min idle
        </Text>
        <Text dimColor>Press any key to close.</Text>
      </Box>
    </Modal>
  );
}
