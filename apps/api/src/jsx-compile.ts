// SPDX-License-Identifier: Apache-2.0
// Constrained JSX → HTML compiler for page authoring.
//
// Agents (and users) can author pages in a small, safe JSX subset instead
// of raw HTML/markdown. This is a hand-written recursive-descent parser —
// there is NO eval / Function / template evaluation anywhere: expressions
// are limited to literals and ternaries over literals, resolved from an
// EMPTY scope, so any identifier or member access is a compile error.
//
// Supported subset:
//   - lowercase HTML elements only (uppercase/component tags are rejected)
//   - fragments <>...</>
//   - attributes: name="string", name='string', name={string|number|boolean
//     literal}, bare boolean attributes; className→class, htmlFor→for
//   - style={{ key: 'value', ... }} objects with string/number values →
//     inline style (camelCase keys become kebab-case)
//   - children: text, nested elements, {expressions} where an expression
//     is a string/number/boolean literal or a ternary over literals
//   - self-closing tags, {/* comments */} (stripped)
// Rejected with clear errors: script/event-handler attributes (on*),
// javascript: URLs are NOT rejected here — the output ALWAYS passes
// through sanitizeHtmlArtifact() before publish/preview, which strips
// them; unknown components, arbitrary JS, spread attributes, and
// mismatched tags are compile errors.
//
// The compiler escapes all text and attribute values, so JSX source can
// never inject raw markup; the sanitizer remains the single enforcement
// path for published/preview HTML regardless.

export class JsxCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsxCompileError';
  }
}

const MAX_SOURCE = 200_000;
const MAX_DEPTH = 100;

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtmlText(s).replace(/"/g, '&quot;');
}

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Attribute name mapping (JSX → HTML). */
const ATTR_NAME_MAP: Record<string, string> = {
  className: 'class',
  htmlFor: 'for',
  tabIndex: 'tabindex',
  readOnly: 'readonly',
  maxLength: 'maxlength',
  colSpan: 'colspan',
  rowSpan: 'rowspan',
};

type LiteralValue = string | number | boolean | null;

class Parser {
  private pos = 0;
  constructor(private readonly src: string) {}

  parse(): string {
    const out = this.parseNodes(0, null);
    this.skipWs();
    if (this.pos < this.src.length) {
      throw new JsxCompileError(`unexpected trailing content at offset ${this.pos}`);
    }
    return out;
  }

  private eof(): boolean {
    return this.pos >= this.src.length;
  }

  private peek(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }

  private skipWs(): void {
    while (!this.eof() && /\s/.test(this.src[this.pos])) this.pos++;
  }

  private expect(s: string): void {
    if (!this.peek(s)) {
      throw new JsxCompileError(`expected "${s}" at offset ${this.pos}`);
    }
    this.pos += s.length;
  }

  /** Parse nodes until the matching closing tag (or EOF at the root). */
  private parseNodes(depth: number, closingTag: string | null): string {
    if (depth > MAX_DEPTH) throw new JsxCompileError('JSX nesting too deep');
    let out = '';
    while (!this.eof()) {
      if (this.peek('</')) {
        if (closingTag === null) {
          throw new JsxCompileError(`unexpected closing tag at offset ${this.pos}`);
        }
        return out; // caller consumes the closing tag
      }
      if (this.peek('{/*')) {
        const end = this.src.indexOf('*/}', this.pos + 3);
        if (end === -1) throw new JsxCompileError('unterminated JSX comment');
        this.pos = end + 3;
        continue;
      }
      if (this.src[this.pos] === '<') {
        out += this.parseElement(depth);
        continue;
      }
      if (this.src[this.pos] === '{') {
        const value = this.parseBracedExpression();
        out += renderLiteralAsText(value);
        continue;
      }
      // Raw text run up to the next '<' or '{'.
      const start = this.pos;
      while (!this.eof() && this.src[this.pos] !== '<' && this.src[this.pos] !== '{') {
        this.pos++;
      }
      out += escapeHtmlText(decodeEntities(this.src.slice(start, this.pos)));
    }
    if (closingTag !== null) {
      throw new JsxCompileError(`unclosed element <${closingTag}>`);
    }
    return out;
  }

  private parseElement(depth: number): string {
    this.expect('<');
    if (this.peek('>')) {
      // Fragment <>...</>
      this.pos++;
      const inner = this.parseNodes(depth + 1, '');
      this.expect('</>');
      return inner;
    }
    const tagMatch = /^[A-Za-z][A-Za-z0-9-]*/.exec(this.src.slice(this.pos));
    if (!tagMatch) throw new JsxCompileError(`invalid tag at offset ${this.pos}`);
    const tag = tagMatch[0];
    this.pos += tag.length;
    if (/^[A-Z]/.test(tag)) {
      throw new JsxCompileError(
        `component <${tag}> is not supported — only lowercase HTML elements are allowed`,
      );
    }
    if (tag === 'script' || tag === 'style' || tag === 'iframe') {
      throw new JsxCompileError(`<${tag}> elements are not allowed in JSX pages`);
    }
    const { attrs, selfClosing } = this.parseAttributes(tag);
    if (selfClosing) return `<${tag}${attrs}>`;
    const inner = this.parseNodes(depth + 1, tag);
    // Consume the closing tag and verify it matches.
    this.expect('</');
    const closeMatch = /^[A-Za-z][A-Za-z0-9-]*/.exec(this.src.slice(this.pos));
    if (!closeMatch) throw new JsxCompileError(`invalid closing tag at offset ${this.pos}`);
    const closeTag = closeMatch[0];
    this.pos += closeTag.length;
    this.skipWs();
    this.expect('>');
    if (closeTag !== tag) {
      throw new JsxCompileError(`mismatched closing tag: expected </${tag}>, got </${closeTag}>`);
    }
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }

  private parseAttributes(tag: string): { attrs: string; selfClosing: boolean } {
    const parts: string[] = [];
    for (;;) {
      this.skipWs();
      if (this.peek('/>')) {
        this.pos += 2;
        return { attrs: parts.length ? ` ${parts.join(' ')}` : '', selfClosing: true };
      }
      if (this.peek('>')) {
        this.pos++;
        return { attrs: parts.length ? ` ${parts.join(' ')}` : '', selfClosing: false };
      }
      if (this.eof()) throw new JsxCompileError(`unterminated <${tag}> tag`);
      if (this.peek('{')) {
        throw new JsxCompileError('spread attributes {...} are not supported');
      }
      const nameMatch = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(this.src.slice(this.pos));
      if (!nameMatch) throw new JsxCompileError(`invalid attribute at offset ${this.pos}`);
      const rawName = nameMatch[0];
      this.pos += rawName.length;
      if (/^on/i.test(rawName)) {
        throw new JsxCompileError(
          `event-handler attribute "${rawName}" is not allowed in JSX pages`,
        );
      }
      const name = ATTR_NAME_MAP[rawName] ?? rawName;
      this.skipWs();
      if (!this.peek('=')) {
        parts.push(name); // bare boolean attribute
        continue;
      }
      this.pos++; // '='
      this.skipWs();
      if (rawName === 'style') {
        parts.push(`style="${escapeAttr(this.parseStyleAttribute())}"`);
        continue;
      }
      const ch = this.src[this.pos];
      if (ch === '"' || ch === "'") {
        const value = this.parseQuoted(ch);
        parts.push(`${name}="${escapeAttr(value)}"`);
      } else if (ch === '{') {
        const value = this.parseBracedExpression();
        if (value === null || value === false) continue; // omitted
        if (value === true) {
          parts.push(name);
        } else {
          parts.push(`${name}="${escapeAttr(String(value))}"`);
        }
      } else {
        throw new JsxCompileError(`invalid value for attribute "${rawName}"`);
      }
    }
  }

  private parseQuoted(quote: string): string {
    this.expect(quote);
    const start = this.pos;
    while (!this.eof() && this.src[this.pos] !== quote) this.pos++;
    if (this.eof()) throw new JsxCompileError('unterminated string literal');
    const raw = this.src.slice(start, this.pos);
    this.pos++; // closing quote
    return decodeEntities(raw);
  }

  /** Parse {{ key: 'value', ... }} (the JSX style-object form). */
  private parseStyleAttribute(): string {
    this.expect('{');
    this.skipWs();
    this.expect('{');
    const decls: string[] = [];
    for (;;) {
      this.skipWs();
      if (this.peek('}')) {
        this.pos++;
        break;
      }
      const keyMatch = /^[A-Za-z][A-Za-z0-9-]*/.exec(this.src.slice(this.pos));
      if (!keyMatch) throw new JsxCompileError('invalid style key');
      const key = keyMatch[0];
      this.pos += key.length;
      this.skipWs();
      this.expect(':');
      this.skipWs();
      const ch = this.src[this.pos];
      let value: string;
      if (ch === '"' || ch === "'") value = this.parseQuoted(ch);
      else if (ch === '-' || (ch >= '0' && ch <= '9')) value = String(this.parseNumber());
      else throw new JsxCompileError('style values must be string or number literals');
      decls.push(`${kebab(key)}: ${value}`);
      this.skipWs();
      if (this.peek(',')) {
        this.pos++;
        continue;
      }
      if (this.peek('}')) {
        this.pos++;
        break;
      }
      throw new JsxCompileError('expected "," or "}" in style object');
    }
    this.skipWs();
    this.expect('}');
    return decls.join('; ');
  }

  /**
   * Parse {expr} where expr is a literal or a ternary over literals.
   * Anything else (identifiers, member access, calls, operators) errors —
   * expressions resolve from an empty scope by design.
   */
  private parseBracedExpression(): LiteralValue {
    this.expect('{');
    const value = this.parseTernary();
    this.skipWs();
    this.expect('}');
    return value;
  }

  private parseTernary(): LiteralValue {
    const cond = this.parseLiteral();
    this.skipWs();
    if (!this.peek('?')) return cond;
    this.pos++;
    const whenTrue = this.parseTernary();
    this.skipWs();
    this.expect(':');
    const whenFalse = this.parseTernary();
    return truthy(cond) ? whenTrue : whenFalse;
  }

  private parseLiteral(): LiteralValue {
    this.skipWs();
    const ch = this.src[this.pos];
    if (ch === '"' || ch === "'" || ch === '`') return this.parseQuoted(ch === '`' ? '`' : ch);
    if (ch === '-' || (ch >= '0' && ch <= '9')) return this.parseNumber();
    if (this.src.startsWith('true', this.pos)) {
      this.pos += 4;
      return true;
    }
    if (this.src.startsWith('false', this.pos)) {
      this.pos += 5;
      return false;
    }
    if (this.src.startsWith('null', this.pos)) {
      this.pos += 4;
      return null;
    }
    if (this.src.startsWith('undefined', this.pos)) {
      this.pos += 9;
      return null;
    }
    const ident = /^[A-Za-z_$][A-Za-z0-9_$.]*/.exec(this.src.slice(this.pos))?.[0] ?? ch ?? '';
    throw new JsxCompileError(
      `unsupported expression "${ident}" — only string/number/boolean literals and ternaries over literals are allowed (expressions resolve from an empty scope)`,
    );
  }

  private parseNumber(): number {
    const m = /^-?\d+(?:\.\d+)?/.exec(this.src.slice(this.pos));
    if (!m) throw new JsxCompileError(`invalid number at offset ${this.pos}`);
    this.pos += m[0].length;
    return Number(m[0]);
  }
}

function truthy(v: LiteralValue): boolean {
  return v !== null && v !== false && v !== 0 && v !== '';
}

function renderLiteralAsText(v: LiteralValue): string {
  if (v === null || typeof v === 'boolean') return '';
  return escapeHtmlText(String(v));
}

/** Decode the small named/numeric entity set JSX authors actually use. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)));
}

/**
 * Compile constrained JSX source to an HTML string. The result is NOT
 * trusted: callers must pass it through sanitizeHtmlArtifact() before
 * publishing or previewing (the single sanitizer path).
 */
export function compileJsxToHtml(source: string): string {
  if (typeof source !== 'string') throw new JsxCompileError('JSX source must be a string');
  if (source.length > MAX_SOURCE) throw new JsxCompileError('JSX source exceeds 200KB');
  return new Parser(source).parse();
}
