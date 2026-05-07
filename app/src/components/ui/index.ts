/**
 * @file index.ts
 * @description UI component abstraction layer — the single swap point for underlying primitives.
 * Responsible for: re-exporting all PropOS UI components.
 * NOT responsible for: business logic, data fetching.
 *
 * IMPORTANT: All consumer components import from @/components/ui (this file),
 * never directly from @radix-ui/* or any other primitive library.
 * To swap the primitive library: update the individual component files, not this index.
 */
export { Button, buttonVariants } from './button'
export type { ButtonProps } from './button'
export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent } from './card'
export { Input } from './input'
export type { InputProps } from './input'
export { Label } from './label'
export { Badge, badgeVariants } from './badge'
export type { BadgeProps } from './badge'
export { Separator } from './separator'
