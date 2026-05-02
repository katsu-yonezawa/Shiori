import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
};

export function IconButton({ children, icon, type = 'button', ...props }: ButtonProps) {
  return (
    <button type={type} {...props}>
      {icon}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

