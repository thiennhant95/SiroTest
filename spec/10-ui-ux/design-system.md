# Design System / UX Quality Bar

Use React + shadcn/ui/Tailwind for speed, but define shared primitives rather than styling screens independently.

Required primitives: Button, Input, Select, Checkbox, Tabs, Dialog, Drawer/Inspector, Tooltip, Toast, Badge, DataTable, EmptyState, Skeleton, ErrorState, StepCard, LocatorBadge, RunStatus.

States must be designed for default/hover/focus/disabled/loading/error/success. Keyboard focus must be visible. Destructive actions require confirmation where data loss is meaningful.

Keep tester-facing language business-readable. Technical details belong in expandable Advanced/Developer sections.
