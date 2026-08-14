export type ReadOnlyRemoteScrollDirection = 'up' | 'down';

export interface ReadOnlyRemoteScrollPayload {
  readonly direction: ReadOnlyRemoteScrollDirection;
  readonly eventCount: number;
}

const READ_ONLY_REMOTE_SCROLL_MAX_EVENTS = 6;

export function parseReadOnlyRemoteScrollPayload(data: string): ReadOnlyRemoteScrollPayload | null {
  if (!data) return null;

  const eventPattern = /\x1b\[<(64|65);[1-9]\d{0,3};[1-9]\d{0,3}M/g;
  let offset = 0;
  let eventCount = 0;
  let direction: ReadOnlyRemoteScrollDirection | undefined;

  for (let match = eventPattern.exec(data); match; match = eventPattern.exec(data)) {
    const fullMatch = match[0];
    const button = match[1];
    if (match.index !== offset) return null;
    offset += fullMatch.length;
    eventCount += 1;
    if (eventCount > READ_ONLY_REMOTE_SCROLL_MAX_EVENTS) return null;

    const nextDirection: ReadOnlyRemoteScrollDirection = button === '64' ? 'up' : 'down';
    if (direction !== undefined && direction !== nextDirection) return null;
    direction = nextDirection;
  }

  if (offset !== data.length || eventCount === 0 || direction === undefined) return null;
  return { direction, eventCount };
}
