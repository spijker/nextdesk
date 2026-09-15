import { useEffect, useRef } from "react";

export interface MenuItem {
  label: string;
  icon?: string;
  onClick(): void;
  danger?: boolean;
  divider?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose(): void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on any click/Escape outside
  useEffect(() => {
    const handler = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) { if (e.key === "Escape") onClose(); return; }
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", handler);
    };
  }, [onClose]);

  // Keep menu on screen
  const MENU_W = 200;
  const MENU_H = items.length * 36 + 8;
  const left = Math.min(x, window.innerWidth - MENU_W - 8);
  const top = Math.min(y, window.innerHeight - MENU_H - 8);

  return (
    <div
      ref={ref}
      className="fixed z-[9999] min-w-[180px] rounded-xl border border-white/10 bg-gray-900/95 py-1 shadow-2xl backdrop-blur-xl"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
      // Without this, a mousedown on an item bubbles to any ancestor
      // "close on outside click" handler (e.g. Desktop's own onMouseDown)
      // before the click fires, unmounting the menu and swallowing the
      // click — the button is visibly there but nothing happens.
      onMouseDown={(e) => e.stopPropagation()}
      onMouseLeave={onClose}
    >
      {items.map((item, i) =>
        item.divider ? (
          <div key={i} className="mx-3 my-1 h-px bg-white/10" />
        ) : (
          <button
            key={i}
            onClick={() => { item.onClick(); onClose(); }}
            className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-white/10 ${
              item.danger ? "text-red-400 hover:text-red-300" : "text-white/85 hover:text-white"
            }`}
          >
            {item.icon && <span className="text-base leading-none">{item.icon}</span>}
            {item.label}
          </button>
        )
      )}
    </div>
  );
}
