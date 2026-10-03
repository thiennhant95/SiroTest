/**
 * Locator mapping for the P0 compiler (06-compiler/playwright-compiler.md):
 *
 * | strategy    | Playwright expression                                  |
 * |-------------|--------------------------------------------------------|
 * | role        | page.getByRole('role'[, { name, exact }])              |
 * | label       | page.getByLabel('value'[, { exact }])                  |
 * | placeholder | page.getByPlaceholder('value'[, { exact }])            |
 * | testId      | page.getByTestId('value')                              |
 * | text        | page.getByText('value'[, { exact }])                   |
 * | css         | page.locator('selector')                               |
 * | xpath       | page.locator('xpath=...')                              |
 *
 * P0 compiles only `primary`; `alternatives` are preserved evidence for P2.
 */
import { stringLiteral } from './variables';

export type LocatorCandidate =
  | { strategy: 'role'; role: string; name?: string; exact?: boolean }
  | { strategy: 'label'; value: string; exact?: boolean }
  | { strategy: 'placeholder'; value: string; exact?: boolean }
  | { strategy: 'testId'; value: string }
  | { strategy: 'text'; value: string; exact?: boolean }
  | { strategy: 'css'; value: string }
  | { strategy: 'xpath'; value: string };

export interface LocatorSpec {
  primary: LocatorCandidate;
  alternatives?: LocatorCandidate[];
}

export class UnsupportedLocatorError extends Error {
  readonly strategy: string;
  constructor(strategy: string) {
    super(`Unsupported locator strategy "${strategy}"`);
    this.name = 'UnsupportedLocatorError';
    this.strategy = strategy;
  }
}

function exactOption(exact?: boolean): string | null {
  return exact === true ? 'exact: true' : null;
}

/**
 * Compile the PRIMARY locator candidate to a `page.…` expression string.
 * Pure + deterministic: same input -> same output. Throws on unknown strategy.
 *
 * P1 wave-2: `pageVar` selects the page handle the locator runs on
 * (`page` by default; `page2`, `page3`, … after `newTab` steps). The P0
 * default keeps byte-identical output when no `newTab` step is present.
 */
export function locatorToExpression(spec: LocatorSpec, pageVar = 'page'): string {
  const c = spec.primary;
  const root = pageVar;
  switch (c.strategy) {
    case 'role': {
      const opts: string[] = [];
      if (c.name !== undefined) opts.push(`name: ${stringLiteral(c.name)}`);
      const ex = exactOption(c.exact);
      if (ex) opts.push(ex);
      const tail = opts.length > 0 ? `, { ${opts.join(', ')} }` : '';
      return `${root}.getByRole(${stringLiteral(c.role)}${tail})`;
    }
    case 'label': {
      const ex = exactOption(c.exact);
      return `${root}.getByLabel(${stringLiteral(c.value)}${ex ? `, { ${ex} }` : ''})`;
    }
    case 'placeholder': {
      const ex = exactOption(c.exact);
      return `${root}.getByPlaceholder(${stringLiteral(c.value)}${ex ? `, { ${ex} }` : ''})`;
    }
    case 'testId':
      return `${root}.getByTestId(${stringLiteral(c.value)})`;
    case 'text': {
      const ex = exactOption(c.exact);
      return `${root}.getByText(${stringLiteral(c.value)}${ex ? `, { ${ex} }` : ''})`;
    }
    case 'css':
      return `${root}.locator(${stringLiteral(c.value)})`;
    case 'xpath': {
      const v = c.value.startsWith('xpath=') ? c.value : `xpath=${c.value}`;
      return `${root}.locator(${stringLiteral(v)})`;
    }
    default:
      throw new UnsupportedLocatorError((c as { strategy: string }).strategy);
  }
}

/**
 * Short human-readable description of a locator, used for default step names.
 * e.g. label "Email" -> `Email`, role button "Login" -> `Login button`.
 */
export function describeLocator(spec: LocatorSpec | undefined): string {
  if (!spec) return '';
  const c = spec.primary;
  switch (c.strategy) {
    case 'role':
      return c.name ? `${c.name} ${c.role}` : c.role;
    case 'label':
    case 'placeholder':
    case 'testId':
    case 'text':
      return c.value;
    case 'css':
    case 'xpath':
      return c.value;
    default:
      return (c as { strategy: string }).strategy;
  }
}
