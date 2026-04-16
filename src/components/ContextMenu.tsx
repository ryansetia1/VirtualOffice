import { useEffect, useRef } from 'react';

export interface MenuItem {
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick, true);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick, true);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  // Keep menu within viewport
  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      ref.current.style.left = `${window.innerWidth - rect.width - 4}px`;
    }
    if (rect.bottom > window.innerHeight) {
      ref.current.style.top = `${window.innerHeight - rect.height - 4}px`;
    }
  }, [x, y]);

  return (
    <div ref={ref} style={{ ...styles.menu, left: x, top: y }}>
      {items.map((item, i) => (
        <button
          key={i}
          style={{
            ...styles.item,
            ...(item.disabled ? styles.itemDisabled : {}),
            ...(item.danger ? styles.itemDanger : {}),
          }}
          disabled={item.disabled}
          onClick={() => { item.onClick(); onClose(); }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  menu: {
    position: 'fixed',
    zIndex: 9999,
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    padding: '4px 0',
    minWidth: '140px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
  },
  item: {
    display: 'block',
    width: '100%',
    padding: '6px 14px',
    background: 'transparent',
    border: 'none',
    fontSize: '12px',
    color: 'var(--text-primary)',
    textAlign: 'left' as const,
    cursor: 'pointer',
  },
  itemDisabled: {
    color: 'var(--text-muted)',
    cursor: 'default',
    opacity: 0.5,
  },
  itemDanger: {
    color: 'var(--danger)',
  },
};
