import { Box, Text } from "ink";
import React from "react";
import wrapAnsi from "wrap-ansi";
import { safeText } from "./catalog.js";

export interface MenuItem {
  label: string;
}
export function SelectionMenu({
  title,
  subtitle,
  items,
  selected,
  context,
  height,
  width,
}: {
  title: string;
  subtitle: string;
  items: MenuItem[];
  selected: number;
  context: string[];
  height: number;
  width: number;
}) {
  const pageSize = Math.max(1, height - 9);
  const start = Math.floor(selected / pageSize) * pageSize;
  const contextLines = context.flatMap((line) =>
    wrapAnsi(safeText(line), Math.max(8, width - 4), { hard: true }).split(
      "\n",
    ),
  );
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold wrap="truncate-end">
        {safeText(title)}
      </Text>
      <Text dimColor wrap="truncate-end">
        {safeText(subtitle)}
      </Text>
      <Text> </Text>
      <Box
        flexDirection="column"
        height={Math.min(pageSize, Math.max(1, items.length))}
      >
        {items.length ? (
          items.slice(start, start + pageSize).map((item, index) => (
            <Text
              key={start + index}
              bold={start + index === selected}
              {...(start + index === selected ? { color: "#77A7DF" } : {})}
              wrap="truncate-end"
            >
              {start + index === selected ? "› " : "  "}
              {safeText(item.label)}
            </Text>
          ))
        ) : (
          <Text dimColor>No entries available.</Text>
        )}
      </Box>
      {items.length > pageSize && (
        <Text dimColor>
          {start + 1}–{Math.min(start + pageSize, items.length)} of{" "}
          {items.length}
        </Text>
      )}
      <Text> </Text>
      {contextLines.slice(0, 3).map((line, index) => (
        <Text key={index} dimColor wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  );
}
