import { AnimatePresence, motion } from 'framer-motion';
import { CloudOff, RefreshCw } from 'lucide-react';
import { useConnectionStatus } from '@/hooks/useConnectionStatus';

/**
 * Persistent banner shown when the board API cannot be reached.
 *
 * Replaces raw proxy errors (e.g. "HTTP 502") with an explicit
 * "backend unavailable" state. It states that the board reconnects on its own
 * and that unsaved input is preserved, and it never blocks the UI so a user
 * can keep working (or keep typing) while the backend is down.
 */
export function ConnectionBanner() {
  const { status } = useConnectionStatus();
  const offline = status === 'disconnected';

  return (
    <AnimatePresence>
      {offline && (
        <motion.div
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="z-40 overflow-hidden border-b border-amber-500/30 bg-amber-500/10"
        >
          <div className="flex items-center gap-2 px-4 py-2 text-xs text-amber-300">
            <CloudOff className="h-3.5 w-3.5 shrink-0" />
            <span className="font-medium">Backend unavailable</span>
            <span className="hidden text-amber-300/70 sm:inline">
              The board API did not respond. Reconnecting automatically — your input is preserved.
            </span>
            <RefreshCw className="ml-auto h-3 w-3 shrink-0 animate-spin text-amber-300/60" />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
