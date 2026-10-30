import { Text } from "ink";

export function Key({ k, label }: { k: string; label: string }) {
  return (
    <Text>
      <Text bold color="cyan">
        {k}
      </Text>
      <Text dimColor> {label}</Text>
    </Text>
  );
}
