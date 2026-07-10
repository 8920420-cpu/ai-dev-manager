import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { AlertCircle, ChevronDown } from 'lucide-react';
import { cn } from '../../lib/cn';
import styles from './Field.module.css';

interface FieldShellProps {
  label: string;
  htmlFor?: string;
  required?: boolean;
  optional?: boolean;
  helper?: ReactNode;
  error?: string | null;
  children: ReactNode;
  /** id вспомогательных текстов для aria-describedby. */
  describedById?: string;
}

/** Обёртка поля: подпись + контрол + helper/ошибка с aria-связями. */
export function FieldShell({
  label,
  htmlFor,
  required,
  optional,
  helper,
  error,
  children,
  describedById,
}: FieldShellProps) {
  return (
    <div className={styles.field}>
      <div className={styles.labelRow}>
        <label className={styles.label} htmlFor={htmlFor}>
          {label}
          {required && (
            <span className={styles.required} aria-hidden="true">
              *
            </span>
          )}
        </label>
        {optional && <span className={styles.optional}>необязательно</span>}
      </div>
      {children}
      {helper && !error && (
        <p className={styles.helper} id={describedById}>
          {helper}
        </p>
      )}
      {error && (
        <p className={styles.error} id={describedById} role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  required?: boolean;
  optional?: boolean;
  helper?: ReactNode;
  error?: string | null;
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, required, optional, helper, error, mono, id, className, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const descId = `${inputId}-desc`;
  return (
    <FieldShell
      label={label}
      htmlFor={inputId}
      required={required}
      optional={optional}
      helper={helper}
      error={error}
      describedById={descId}
    >
      <input
        ref={ref}
        id={inputId}
        className={cn(styles.control, mono && styles.mono, error && styles.invalid, className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={helper || error ? descId : undefined}
        aria-required={required || undefined}
        {...rest}
      />
    </FieldShell>
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  required?: boolean;
  helper?: ReactNode;
  error?: string | null;
  children: ReactNode;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, required, helper, error, id, className, children, ...rest },
  ref,
) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const descId = `${selectId}-desc`;
  return (
    <FieldShell
      label={label}
      htmlFor={selectId}
      required={required}
      helper={helper}
      error={error}
      describedById={descId}
    >
      <div className={styles.selectWrap}>
        <select
          ref={ref}
          id={selectId}
          className={cn(styles.control, error && styles.invalid, className)}
          aria-invalid={error ? true : undefined}
          aria-describedby={helper || error ? descId : undefined}
          {...rest}
        >
          {children}
        </select>
        <ChevronDown size={16} className={styles.selectIcon} aria-hidden="true" />
      </div>
    </FieldShell>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  required?: boolean;
  helper?: ReactNode;
  error?: string | null;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ label, required, helper, error, id, className, ...rest }, ref) {
    const autoId = useId();
    const taId = id ?? autoId;
    const descId = `${taId}-desc`;
    return (
      <FieldShell
        label={label}
        htmlFor={taId}
        required={required}
        helper={helper}
        error={error}
        describedById={descId}
      >
        <textarea
          ref={ref}
          id={taId}
          className={cn(styles.control, error && styles.invalid, className)}
          aria-invalid={error ? true : undefined}
          aria-describedby={helper || error ? descId : undefined}
          {...rest}
        />
      </FieldShell>
    );
  },
);
