"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useCallback } from "react";
import type { ComponentPropsWithoutRef } from "react";

type DialogContentProps = ComponentPropsWithoutRef<typeof Dialog.Content>;
type PointerDownOutsideEvent = Parameters<NonNullable<DialogContentProps["onPointerDownOutside"]>>[0];
type EscapeKeyDownEvent = Parameters<NonNullable<DialogContentProps["onEscapeKeyDown"]>>[0];
type FocusOutsideEvent = Parameters<NonNullable<DialogContentProps["onFocusOutside"]>>[0];
type InteractOutsideEvent = Parameters<NonNullable<DialogContentProps["onInteractOutside"]>>[0];

export function useDialogDismiss(
  onClose: () => void,
) {
  const requestClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleOpenChange = useCallback((open: boolean) => {
    if (open) {
      return;
    }
  }, []);

  const handlePointerDownOutside = useCallback((event: PointerDownOutsideEvent) => {
    event.preventDefault();
  }, []);

  const handleEscapeKeyDown = useCallback((event: EscapeKeyDownEvent) => {
    event.preventDefault();
  }, []);

  const handleFocusOutside = useCallback((event: FocusOutsideEvent) => {
    event.preventDefault();
  }, []);

  const handleInteractOutside = useCallback((event: InteractOutsideEvent) => {
    event.preventDefault();
  }, []);

  return {
    handleOpenChange,
    handlePointerDownOutside,
    handleEscapeKeyDown,
    handleFocusOutside,
    handleInteractOutside,
    requestClose,
  };
}
