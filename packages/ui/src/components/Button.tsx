// RG-013: Standardized button component with Tailwind and accessibility
import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../utils/cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-field font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed',
  {
    variants: {
      variant: {
        default: 'bg-brand text-white hover:bg-brand-hover focus-visible:ring-focus-ring',
        secondary: 'bg-surface-sunken text-text-primary hover:bg-border-subtle focus-visible:ring-focus-ring',
        destructive: 'bg-state-pending text-white hover:brightness-90 focus-visible:ring-state-pending',
        outline: 'border border-border-strong bg-surface-raised hover:bg-surface-sunken focus-visible:ring-focus-ring',
        ghost: 'hover:bg-surface-sunken focus-visible:ring-focus-ring',
      },
      size: {
        sm: 'h-8 px-3 text-body',
        default: 'h-10 px-4 text-body',
        lg: 'h-12 px-6 text-subtitle',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props}
    />
  )
);

Button.displayName = 'Button';

export { Button, buttonVariants };
