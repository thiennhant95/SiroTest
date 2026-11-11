# Test Definition Specification

Canonical format is versioned JSON.

```ts
interface TestDefinition {
  schemaVersion: '1.0';
  id: string;
  projectId: string;
  name: string;
  description?: string;
  browser: 'chromium' | 'firefox' | 'webkit';
  baseUrl?: string;
  viewport?: { width: number; height: number };
  timeoutMs?: number;
  tags?: string[];
  variables?: Record<string, string>;
  steps: TestStep[];
}
```

Every step contains:

```ts
interface BaseStep {
  id: string;
  type: string;
  name?: string;
  enabled: boolean;
  timeoutMs?: number;
  continueOnFailure?: boolean;
}
```

## Locator

```ts
interface LocatorSpec {
  primary: LocatorCandidate;
  alternatives?: LocatorCandidate[];
}

type LocatorCandidate =
 | { strategy: 'role'; role: string; name?: string; exact?: boolean }
 | { strategy: 'label'; value: string; exact?: boolean }
 | { strategy: 'placeholder'; value: string; exact?: boolean }
 | { strategy: 'testId'; value: string }
 | { strategy: 'text'; value: string; exact?: boolean }
 | { strategy: 'css'; value: string }
 | { strategy: 'xpath'; value: string };
```

Store alternatives from day one even though P0 executes only primary.

## Compatibility
Never silently mutate stored definitions. `schemaVersion` migrations must be explicit, deterministic and tested.
