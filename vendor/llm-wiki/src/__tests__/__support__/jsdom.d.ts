// Type declarations for jsdom — used in unit tests that need a DOM
// environment for renderThinkingBlocksUI and similar pure-DOM constructors.
// @see https://github.com/jsdom/jsdom
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: Record<string, unknown>);
    // eslint-disable-next-line obsidianmd/no-global-this
    window: Window & typeof globalThis;
  }
}
