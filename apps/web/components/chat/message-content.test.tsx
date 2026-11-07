// SPDX-License-Identifier: Apache-2.0
// Assistant answers must render as markdown (2026-11-07 defect: the
// Universal Chat greeting showed literal ### / ** markers). The fix
// routes assistant text through AssistantMessageText → the shared
// renderMarkdownLite; user text (SpoilerText) stays literal.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { AssistantMessageText, SpoilerText } from './message-content';

afterEach(() => cleanup());

describe('AssistantMessageText', () => {
  it('renders a markdown answer as formatted content, not raw markers', () => {
    const { container } = render(
      <AssistantMessageText
        text={'Hello! Here is a snapshot:\n\n### 📚 Research\n\n* **Web search** – find the latest news\n* **Source citation** – references for every fact'}
      />,
    );
    const heading = container.querySelector('h4');
    expect(heading).not.toBeNull();
    expect(heading?.textContent).toContain('Research');
    expect(container.querySelectorAll('strong').length).toBeGreaterThanOrEqual(2);
    expect(container.querySelectorAll('li').length).toBe(2);
    // The raw markers must not survive into the rendered text.
    expect(container.textContent).not.toContain('###');
    expect(container.textContent).not.toContain('**');
    expect(container.querySelector('.msg-md')).not.toBeNull();
  });

  it('does not let model text inject HTML', () => {
    const { container } = render(
      <AssistantMessageText text={'Look: <script>alert(1)</script> and <img src=x onerror=alert(2)>'} />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('keeps ||spoiler|| spans blurred inside a markdown answer', () => {
    const { container } = render(
      <AssistantMessageText text={'The answer is ||a **secret**|| — **bold** claim.'} />,
    );
    const spoiler = container.querySelector('.spoiler');
    expect(spoiler).not.toBeNull();
    expect(spoiler?.textContent).toBe('a **secret**');
    // Markdown outside the spoiler still renders.
    expect(container.querySelector('strong')?.textContent).toBe('bold');
  });

  it('renders plain prose without inventing structure', () => {
    const { container } = render(<AssistantMessageText text={'Done — the file is written.'} />);
    expect(container.querySelector('.msg-md p')?.textContent).toBe('Done — the file is written.');
  });

  it('renders a markdown table as a real table (2026-11-07 renderer parity)', () => {
    const { container } = render(
      <AssistantMessageText text={'Results:\n\n| Name | Score |\n| --- | ---: |\n| Ada | 9 |'} />,
    );
    const table = container.querySelector('.md-table-wrap table');
    expect(table).not.toBeNull();
    expect(table?.querySelector('th')?.textContent).toBe('Name');
    expect(table?.querySelector('td')?.textContent).toBe('Ada');
    expect(container.textContent).not.toContain('| --- |');
  });

  it('renders math and a code block whose Copy button copies the code', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { container } = render(
      <AssistantMessageText text={'Math $x^2$ and code:\n\n```ts\nconst answer = 42;\n```'} />,
    );
    expect(container.querySelector('.katex')).not.toBeNull();
    const btn = container.querySelector<HTMLButtonElement>('[data-md-copy]');
    expect(btn).not.toBeNull();
    expect(container.querySelector('.md-codeblock-lang')?.textContent).toBe('ts');
    fireEvent.click(btn!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const answer = 42;'));
    await waitFor(() => expect(btn?.textContent).toBe('Copied'));
  });
});

describe('SpoilerText (user/plain path, unchanged)', () => {
  it('leaves markdown markers literal in plain text', () => {
    const { container } = render(<SpoilerText text={'I typed **stars** and ### hashes'} />);
    expect(container.textContent).toBe('I typed **stars** and ### hashes');
    expect(container.querySelector('strong')).toBeNull();
  });
});
