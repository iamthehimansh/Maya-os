import { describe, it, expect } from 'vitest';
import React from 'react';
import { Text, useInput } from 'ink';
import { render } from 'ink-testing-library';

function Echo(): React.ReactElement {
  const [s, setS] = React.useState('');
  useInput((input) => setS((p) => p + input));
  return <Text>[{s}]</Text>;
}

describe('tsx toolchain', () => {
  it('renders an ink component and reads the frame', () => {
    const { lastFrame } = render(<Text>hello-tui</Text>);
    expect(lastFrame()).toContain('hello-tui');
  });

  it('delivers stdin keypresses', async () => {
    const { stdin, lastFrame } = render(<Echo />);
    stdin.write('x');
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame()).toContain('[x]');
  });
});
