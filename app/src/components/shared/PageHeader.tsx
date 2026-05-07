/**
 * @file PageHeader.tsx
 * @description Reusable page header with title, optional description, and action slot.
 * Responsible for: consistent page-level heading across all PropOS modules.
 * NOT responsible for: module-specific actions (passed via children).
 */
interface PageHeaderProps {
  title: string
  description?: string
  children?: React.ReactNode
}

export function PageHeader({ title, description, children }: PageHeaderProps) {
  return (
    <div className="flex items-start justify-between px-8 py-6 border-b">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {description && (
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        )}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  )
}
