/**
 * @file utils.ts
 * @description General utility functions for PropOS.
 * Responsible for: class name merging (Tailwind), date formatting, and other shared helpers.
 * NOT responsible for: financial utilities (see money.ts), API calls (see supabase.ts).
 */
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merge Tailwind class names, resolving conflicts correctly. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * Format an ISO 8601 date string to UK locale display format.
 * @example formatDate("2026-05-07") → "07/05/2026"
 */
export function formatDate(isoDate: string | null | undefined): string {
  if (!isoDate) return '—'
  return new Date(isoDate).toLocaleDateString('en-GB')
}

/**
 * Format an ISO 8601 datetime string to UK locale display format with time.
 * @example formatDateTime("2026-05-07T14:30:00Z") → "07/05/2026, 14:30"
 */
export function formatDateTime(isoDatetime: string | null | undefined): string {
  if (!isoDatetime) return '—'
  return new Date(isoDatetime).toLocaleString('en-GB', {
    dateStyle: 'short',
    timeStyle: 'short',
  })
}

/**
 * Returns the number of days between today and a future date.
 * Returns a negative number if the date is in the past.
 */
export function daysUntil(isoDate: string | null | undefined): number | null {
  if (!isoDate) return null
  const target = new Date(isoDate)
  const now = new Date()
  const diffMs = target.getTime() - now.getTime()
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24))
}

/**
 * Returns a RAG status string based on days until expiry.
 * Red ≤14 days, Amber ≤90 days, Green otherwise.
 */
export function ragStatus(daysRemaining: number | null): 'red' | 'amber' | 'green' | 'unknown' {
  if (daysRemaining == null) return 'unknown'
  if (daysRemaining <= 14) return 'red'
  if (daysRemaining <= 90) return 'amber'
  return 'green'
}

/** Truncate a string to a maximum length with an ellipsis. */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str
  return str.slice(0, maxLength - 1) + '…'
}

/** Convert a slug to title case for display. */
export function slugToTitle(slug: string): string {
  return slug
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}
