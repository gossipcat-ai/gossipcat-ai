import { useEffect, type ReactNode, type HTMLAttributes } from 'react';

/**
 * Hand-rolled minimal Sheet primitive. Exposes the shadcn-style surface
 * (Sheet, SheetContent, SheetHeader, SheetTitle) used by
 * FindingDetailDrawer. Built directly rather than via `npx shadcn add sheet`
 * because this project does not depend on @radix-ui/react-dialog; pulling it
 * in just for one side panel is heavier than a ~60-line bespoke primitive.
 *
 * Behaviour:
 * - Click the backdrop to close.
 * - Escape closes.
 * - Body scroll is locked while open.
 * - `side="right"` renders the panel flush to the right edge (other sides
 *   are accepted for API parity but collapse to right since the drawer only
 *   ever uses right).
 */

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

export function Sheet({ open, onOpenChange, children }: SheetProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-background/70 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
      />
      <div className="absolute inset-y-0 right-0 flex">
        {/* stopPropagation keeps clicks inside the panel from closing it */}
        <div onClick={(e) => e.stopPropagation()} className="contents">
          {children}
        </div>
      </div>
    </div>
  );
}

interface SheetContentProps extends HTMLAttributes<HTMLDivElement> {
  side?: 'right' | 'left' | 'top' | 'bottom';
  children: ReactNode;
}

export function SheetContent({ side: _side = 'right', className = '', children, ...rest }: SheetContentProps) {
  return (
    <div
      className={`h-full border-l border-border/60 bg-card shadow-xl p-6 ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

export function SheetHeader({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`mb-2 ${className}`} {...rest} />;
}

export function SheetTitle({ className = '', ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={`font-semibold ${className}`} {...rest} />;
}
