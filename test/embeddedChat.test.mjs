import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Chat belongs to Inbox rather than a registered workspace tab', () => {
  const main = readFileSync('src/main.ts', 'utf8');
  const inbox = readFileSync('src/inboxView.ts', 'utf8');
  const chat = readFileSync('src/reviewChatView.ts', 'utf8');
  assert.doesNotMatch(main, /registerView\(VIEW_TYPE_CHAT/);
  assert.doesNotMatch(chat, /extends ItemView|role: "tablist"/);
  assert.match(inbox, /new ChatView\(/);
  assert.match(main, /\.focusChat\(\)/);
  assert.match(inbox, /this\.chat\?\.onClose\(\)/);
});
