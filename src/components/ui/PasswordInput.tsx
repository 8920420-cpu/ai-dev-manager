import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '../../lib/cn';
import { FieldShell } from './Field';
import styles from './Field.module.css';

interface PasswordInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
  required?: boolean;
  helper?: ReactNode;
  error?: string | null;
}

/** Поле пароля с переключателем показа/скрытия. Значение не логируется. */
export function PasswordInput({
  label,
  required,
  helper,
  error,
  id,
  className,
  ...rest
}: PasswordInputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const descId = `${inputId}-desc`;
  const [visible, setVisible] = useState(false);

  return (
    <FieldShell
      label={label}
      htmlFor={inputId}
      required={required}
      helper={helper}
      error={error}
      describedById={descId}
    >
      <div
        className={cn(
          styles.control,
          styles.controlWrap,
          error && styles.invalid,
          className,
        )}
      >
        <input
          id={inputId}
          type={visible ? 'text' : 'password'}
          autoComplete="current-password"
          aria-invalid={error ? true : undefined}
          aria-describedby={helper || error ? descId : undefined}
          aria-required={required || undefined}
          {...rest}
        />
        <button
          type="button"
          className={styles.adornBtn}
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Скрыть пароль' : 'Показать пароль'}
          aria-pressed={visible}
          tabIndex={0}
        >
          {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
        </button>
      </div>
    </FieldShell>
  );
}
