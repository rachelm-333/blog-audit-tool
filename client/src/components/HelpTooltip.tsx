/**
 * HelpTooltip — inline ? icon with a plain-English tooltip
 *
 * Usage:
 *   <HelpTooltip text="Your brand voice describes how your business sounds in writing. Use 2–4 adjectives like 'friendly, professional, direct'." />
 *
 * The tooltip is an inline toggle — it does not open a modal or navigate away.
 * Clicking the ? icon shows/hides the tooltip. Clicking outside dismisses it.
 */
import { useState, useRef, useEffect } from "react";
import { HelpCircle } from "lucide-react";

interface HelpTooltipProps {
  text: string;
  /** Optional: position the tooltip to the left instead of right */
  align?: "left" | "right";
}

export function HelpTooltip({ text, align = "right" }: HelpTooltipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <span
      ref={ref}
      className="relative inline-flex items-center ml-1.5"
      style={{ verticalAlign: "middle" }}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="text-muted-foreground hover:text-foreground transition-colors focus:outline-none focus:ring-2 focus:ring-ring rounded-full"
        aria-label="Show help"
        aria-expanded={open}
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </button>

      {open && (
        <span
          className={`absolute z-50 w-64 rounded-lg border border-border bg-popover text-popover-foreground shadow-md p-3 text-xs leading-relaxed
            ${align === "right" ? "left-5 top-0" : "right-5 top-0"}`}
          style={{ minWidth: "220px" }}
        >
          {text}
        </span>
      )}
    </span>
  );
}
