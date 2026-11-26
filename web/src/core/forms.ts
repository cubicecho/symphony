import type { FormEvent } from 'react';

/**
 * Builds a `<form>`'s submit handler that keeps the browser from navigating and hands over to the form library.
 *
 * @param submit - The form's `handleSubmit`.
 * @returns The `onSubmit` handler.
 *
 * @remarks
 * Stands in for cubeui's `FormElement`, which this app has not installed yet.
 */
export function onFormSubmit(submit: () => unknown): (event: FormEvent<HTMLFormElement>) => void {
  return (event) => {
    event.preventDefault();
    event.stopPropagation();
    void submit();
  };
}
