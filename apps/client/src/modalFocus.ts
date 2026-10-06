import { useLayoutEffect, useRef } from 'react';

interface Modal { element: HTMLElement; launcher: HTMLElement | null }
const stack: Modal[] = [];
const top = () => stack.at(-1);
function controls(element: HTMLElement): HTMLElement[] {
  return [...element.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], summary, [tabindex]')]
    .filter(control => control.tabIndex >= 0 && !control.matches(':disabled') && control.getClientRects().length > 0);
}
function focusInitial(element: HTMLElement): void {
  const available = controls(element);
  (available.find(control => control.hasAttribute('data-modal-initial-focus')) ?? available[0] ?? element).focus();
}

/** Only the top dialog owns keyboard focus; closing it returns to its launcher. */
export function useModalFocus<T extends HTMLElement = HTMLElement>(active = true, dismiss?: () => void) {
  const ref = useRef<T>(null), dismissRef = useRef(dismiss); dismissRef.current = dismiss;
  useLayoutEffect(() => {
    const element = ref.current; if (!active || !element) return;
    const modal: Modal = { element, launcher: document.activeElement instanceof HTMLElement ? document.activeElement : null };
    const priorTabIndex = element.getAttribute('tabindex'); element.tabIndex = -1;
    element.setAttribute('data-modal-active', ''); stack.push(modal);
    const contain = (event: FocusEvent) => { if (top() === modal && event.target instanceof Node && !element.contains(event.target)) focusInitial(element); };
    const key = (event: KeyboardEvent) => {
      if (top() !== modal || event.defaultPrevented) return;
      if (event.key === 'Escape' && dismissRef.current) { event.preventDefault(); event.stopPropagation(); dismissRef.current(); return; }
      if (event.key !== 'Tab') return;
      const available = controls(element), first = available[0], last = available.at(-1);
      if (!first) { event.preventDefault(); element.focus(); }
      else if (!element.contains(document.activeElement) || document.activeElement === element || document.activeElement === (event.shiftKey ? first : last)) {
        event.preventDefault(); (event.shiftKey ? last! : first).focus();
      }
    };
    document.addEventListener('focusin', contain); document.addEventListener('keydown', key); focusInitial(element);
    return () => {
      const wasTop = top() === modal;
      document.removeEventListener('focusin', contain); document.removeEventListener('keydown', key);
      element.removeAttribute('data-modal-active');
      if (priorTabIndex === null) element.removeAttribute('tabindex'); else element.setAttribute('tabindex', priorTabIndex);
      // If a parent closes before its child, the child inherits the original
      // launcher rather than restoring focus into the detached parent.
      for (const child of stack) if (child !== modal && child.launcher && element.contains(child.launcher)) child.launcher = modal.launcher;
      stack.splice(stack.indexOf(modal), 1);
      if (wasTop) {
        const parent = top();
        if (modal.launcher?.isConnected && (!parent || parent.element.contains(modal.launcher))) modal.launcher.focus();
        else if (parent) focusInitial(parent.element);
      }
    };
  }, [active]);
  return ref;
}
