// SPDX-License-Identifier: Apache-2.0
// Static render tests (react-dom/server — no jsdom needed) for the voice UI.
// Interactive flows (record → stop → transcribe) are covered in
// lib/voice-notes.test.ts and lib/voice-call.test.ts.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MockSTTProvider, MockTTSProvider } from '@mvp/voice';
import VoiceNoteBubble from './VoiceNoteBubble';
import VoiceNoteRecorder from './VoiceNoteRecorder';
import CallPanel from './CallPanel';

describe('VoiceNoteBubble', () => {
  it('renders playback controls, duration, and transcript', () => {
    const html = renderToStaticMarkup(
      React.createElement(VoiceNoteBubble, {
        audioDataUrl: 'data:audio/webm;base64,AAA',
        mimeType: 'audio/webm',
        durationMs: 5000,
        transcript: 'hello from the mic',
      }),
    );
    expect(html).toContain('aria-label="Voice note"');
    expect(html).toContain('▶');
    expect(html).toContain('0:05');
    expect(html).toContain('Transcript');
    expect(html).toContain('hello from the mic');
    expect(html).toContain('src="data:audio/webm;base64,AAA"');
  });

  it('renders without a transcript', () => {
    const html = renderToStaticMarkup(
      React.createElement(VoiceNoteBubble, { audioDataUrl: 'data:audio/webm;base64,AAA' }),
    );
    expect(html).toContain('▶');
    expect(html).toContain('0:00');
  });
});

describe('VoiceNoteRecorder', () => {
  it('renders the composer mic button in idle state', () => {
    const html = renderToStaticMarkup(
      React.createElement(VoiceNoteRecorder, {
        stt: new MockSTTProvider(),
        onVoiceNote: () => {},
      }),
    );
    expect(html).toContain('🎙️');
    expect(html).toContain('aria-label="Record voice note"');
    expect(html).not.toContain('recording');
  });

  it('renders disabled when the composer is busy', () => {
    const html = renderToStaticMarkup(
      React.createElement(VoiceNoteRecorder, {
        stt: new MockSTTProvider(),
        onVoiceNote: () => {},
        disabled: true,
      }),
    );
    expect(html).toContain('disabled');
  });
});

describe('CallPanel', () => {
  const props = {
    botId: 'bot_1',
    botName: 'TestBot',
  };

  it('renders the pre-call state with the start button and provider pickers', () => {
    const html = renderToStaticMarkup(React.createElement(CallPanel, props));
    expect(html).toContain('Voice call');
    expect(html).toContain('Start call');
    expect(html).toContain('TestBot');
    expect(html).toContain('Speech-to-text');
    expect(html).toContain('Auto voice detection');
  });

  it('does not show the mic button before the call starts', () => {
    const html = renderToStaticMarkup(React.createElement(CallPanel, props));
    // The mic button (mic-big) only renders once the call is live.
    expect(html).not.toContain('mic-big');
    // But the idle hint still explains tap-to-talk.
    expect(html).toContain('tap the mic');
  });

  it('prompts for a bot when none is selected is handled by the page, not the panel', () => {
    const html = renderToStaticMarkup(React.createElement(CallPanel, { botId: 'bot_1' }));
    expect(html).toContain('aria-label="Voice call"');
  });
});
