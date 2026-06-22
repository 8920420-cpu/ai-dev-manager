import { clsx, type ClassValue } from 'clsx';

/** Утилита склейки классов (обёртка над clsx). */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
