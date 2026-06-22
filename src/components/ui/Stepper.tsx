import { Check } from 'lucide-react';
import { cn } from '../../lib/cn';
import styles from './Stepper.module.css';

interface Step {
  label: string;
}

interface StepperProps {
  steps: Step[];
  /** Текущий шаг (0-based). */
  current: number;
}

export function Stepper({ steps, current }: StepperProps) {
  return (
    <ol className={styles.stepper} aria-label="Шаги создания проекта">
      {steps.map((step, i) => {
        const state =
          i < current ? 'done' : i === current ? 'current' : 'upcoming';
        return (
          <li
            key={step.label}
            className={cn(styles.step, styles[state])}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className={styles.marker} aria-hidden="true">
              {state === 'done' ? <Check size={14} /> : i + 1}
            </span>
            <span className={styles.label}>
              <span className={styles.stepNo}>Шаг {i + 1}</span>
              {step.label}
            </span>
            {i < steps.length - 1 && <span className={styles.bar} aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}
