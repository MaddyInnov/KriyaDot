// SPDX-License-Identifier: Apache-2.0
// Locale dictionaries for the KriyaDot web console.
//
// English is the source of truth: every other locale must provide the exact
// same key shape (enforced by `Strings = typeof en` and checked in
// lib/i18n.test.ts). Keep values UI-facing only — no secrets, no PII.
//
// Adding strings: add the key to `en` first, mirror it in every other
// locale, then use it via `t('path.to.key')` (see docs/I18N.md).

/** Interpolation helper: replaces `{name}` placeholders in a template. */
export function fill(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in vars ? String(vars[name]) : `{${name}}`,
  );
}

export const en = {
  common: {
    language: 'Language',
    close: 'Close',
    cancel: 'Cancel',
    loading: 'Loading…',
  },
  nav: {
    chat: 'Chat',
    bots: 'Bots',
    workflows: 'Workflows',
    marketplace: 'Marketplace',
    workspace: 'Workspace',
    activity: 'Activity',
  },
  chat: {
    title: 'Chat',
    newChat: '＋ New chat',
    composerPlaceholder: 'Message {bot}…  ( / for commands )',
    composerPlaceholderNoBot: 'Select a bot first…',
    composerLabel: 'Chat message',
    send: 'Send',
    stop: 'Stop',
    stopTitle: 'Stop the running turn',
    modeChat: '💬 Chat',
    modeCall: '📞 Call',
    modeChatLabel: 'Chat mode',
    modeCallLabel: 'Voice call mode',
    emptyAsk: 'Ask {pet} anything…',
  },
  voice: {
    micStart: 'Record voice note',
    micStop: 'Stop and send voice note',
    micRecording: 'Recording… tap to stop',
    transcribing: 'Transcribing…',
    micDenied: 'Microphone unavailable',
    play: 'Play voice note',
    pause: 'Pause voice note',
    transcript: 'Transcript',
    voiceNote: 'Voice note',
    duration: '{duration}',
  },
  call: {
    title: 'Voice call',
    start: 'Start call',
    end: 'End call',
    tapToTalk: '🎙 Tap to talk',
    stopAndSend: '⏹ Stop & send',
    listening: 'Listening…',
    thinking: 'Thinking…',
    speaking: 'Speaking…',
    idleHint: 'Start the call, then tap the mic to talk to the bot. Mock voice providers are used — no audio leaves this demo path.',
    empty: 'No turns yet — tap the mic and say something.',
    you: 'You',
    bot: 'Bot',
    turnAt: '{time}',
  },
  bots: {
    title: 'Bots',
    subtitle:
      'Per-bot governance policies. Tool calls are evaluated against the bot\u2019s rules first, then the global policy.',
    roster: 'Bots',
    tabPolicy: 'Policy',
    tabRobustness: 'Robustness',
    tabComputer: 'Computer',
    tabMemory: 'Memory',
    tabModel: 'Model',
    selectPrompt: 'Select a bot to edit its policy.',
    loadingBots: 'Loading bots…',
  },
};

/** The full string table shape — every locale must match `en` exactly. */
export type Strings = typeof en;

export const hi: Strings = {
  common: {
    language: 'भाषा',
    close: 'बंद करें',
    cancel: 'रद्द करें',
    loading: 'लोड हो रहा है…',
  },
  nav: {
    chat: 'चैट',
    bots: 'बॉट्स',
    workflows: 'वर्कफ़्लो',
    marketplace: 'मार्केटप्लेस',
    workspace: 'वर्कस्पेस',
    activity: 'गतिविधि',
  },
  chat: {
    title: 'चैट',
    newChat: '＋ नई चैट',
    composerPlaceholder: '{bot} को संदेश भेजें…  ( / से कमांड )',
    composerPlaceholderNoBot: 'पहले एक बॉट चुनें…',
    composerLabel: 'चैट संदेश',
    send: 'भेजें',
    stop: 'रोकें',
    stopTitle: 'चल रहे टर्न को रोकें',
    modeChat: '💬 चैट',
    modeCall: '📞 कॉल',
    modeChatLabel: 'चैट मोड',
    modeCallLabel: 'वॉइस कॉल मोड',
    emptyAsk: '{pet} से कुछ भी पूछें…',
  },
  voice: {
    micStart: 'वॉइस नोट रिकॉर्ड करें',
    micStop: 'रिकॉर्डिंग रोकें और वॉइस नोट भेजें',
    micRecording: 'रिकॉर्डिंग चल रही है… रोकने के लिए टैप करें',
    transcribing: 'ट्रांसक्राइब हो रहा है…',
    micDenied: 'माइक्रोफ़ोन उपलब्ध नहीं है',
    play: 'वॉइस नोट चलाएँ',
    pause: 'वॉइस नोट रोकें',
    transcript: 'ट्रांसक्रिप्ट',
    voiceNote: 'वॉइस नोट',
    duration: '{duration}',
  },
  call: {
    title: 'वॉइस कॉल',
    start: 'कॉल शुरू करें',
    end: 'कॉल समाप्त करें',
    tapToTalk: '🎙 बोलने के लिए टैप करें',
    stopAndSend: '⏹ रोकें और भेजें',
    listening: 'सुन रहा है…',
    thinking: 'सोच रहा है…',
    speaking: 'बोल रहा है…',
    idleHint: 'कॉल शुरू करें, फिर बॉट से बात करने के लिए माइक टैप करें। मॉक वॉइस प्रोवाइडर इस्तेमाल हो रहे हैं — कोई ऑडियो बाहर नहीं जाता।',
    empty: 'अभी कोई टर्न नहीं — माइक टैप करें और कुछ कहें।',
    you: 'आप',
    bot: 'बॉट',
    turnAt: '{time}',
  },
  bots: {
    title: 'बॉट्स',
    subtitle:
      'प्रति-बॉट गवर्नेंस नीतियाँ। टूल कॉल पहले बॉट के नियमों से, फिर वैश्विक नीति से जाँचे जाते हैं।',
    roster: 'बॉट्स',
    tabPolicy: 'नीति',
    tabRobustness: 'मज़बूती',
    tabComputer: 'कंप्यूटर',
    tabMemory: 'याददाश्त',
    tabModel: 'मॉडल',
    selectPrompt: 'नीति संपादित करने के लिए एक बॉट चुनें।',
    loadingBots: 'बॉट्स लोड हो रहे हैं…',
  },
};
