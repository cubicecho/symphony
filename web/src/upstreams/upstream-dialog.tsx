import { useState } from 'react';
import { InputField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { FieldRow } from '@/components/field-row';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Plus, Trash2 } from '@/components/ui/icons';
import { onFormSubmit } from '@/core/forms';
import { messageOf } from '@/lib/error-message';
import { type Upstream, useAddUpstream, useUpdateUpstream } from './use-upstreams.ts';

/** The schemes an upstream's URL may use. */
const WEB_PROTOCOLS = ['http:', 'https:'];
/** A header value that names a server environment variable instead of holding the secret. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: the server's reference syntax, shown as typed.
const ENV_REFERENCE_EXAMPLE = '${env:SYMPHONY_SHOP_TOKEN}';

interface UpstreamDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The upstream to edit. Left out, the dialog adds one. */
  upstream?: Upstream | undefined;
}

/** One header row as the form holds it. */
interface HeaderDraft {
  name: string;
  value: string;
}

/** What the form holds. */
interface UpstreamDraft {
  name: string;
  url: string;
  headers: HeaderDraft[];
}

/**
 * Checks an upstream's URL.
 *
 * @param value - What was typed.
 * @returns Why it is refused, or undefined when it is an http(s) URL.
 */
function checkUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    const isWeb = WEB_PROTOCOLS.includes(url.protocol);
    return isWeb ? undefined : 'Use an http:// or https:// address.';
  } catch {
    return 'Type the GraphQL endpoint’s full address, such as https://api.example.com/graphql.';
  }
}

/**
 * Drops the header rows left wholly blank and trims the rest.
 *
 * @param headers - The rows as typed.
 * @returns What the API takes.
 */
function cleanHeaders(headers: HeaderDraft[]): HeaderDraft[] {
  return headers
    .map((header) => ({ name: header.name.trim(), value: header.value.trim() }))
    .filter((header) => header.name !== '' || header.value !== '');
}

/** Adds an upstream, or changes one's name, address and headers. */
export function UpstreamDialog({ open, onOpenChange, upstream }: UpstreamDialogProps) {
  const addUpstream = useAddUpstream();
  const updateUpstream = useUpdateUpstream();
  const [serverError, setServerError] = useState<string | undefined>(undefined);
  const isEdit = upstream !== undefined;

  const defaultValues: UpstreamDraft = {
    name: upstream?.name ?? '',
    url: upstream?.url ?? '',
    headers: upstream?.headers.map(({ name, value }) => ({ name, value })) ?? [],
  };
  const form = useAppForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      setServerError(undefined);
      const fields = { name: value.name.trim(), url: value.url.trim(), headers: cleanHeaders(value.headers) };
      try {
        if (isEdit) {
          await updateUpstream.mutateAsync({ id: upstream.id, ...fields });
        } else {
          await addUpstream.mutateAsync(fields);
        }
        onOpenChange(false);
      } catch (error) {
        setServerError(messageOf(error) ?? 'The upstream was not saved. Try again.');
      }
    },
  });

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={isEdit ? `Edit ${upstream.name}` : 'Add upstream'}
      description={
        isEdit ? undefined : 'A GraphQL API for modules to read. Symphony introspects it as soon as it is added.'
      }
      hasUnsavedChanges={() => form.state.isDefaultValue === false}
      wrapperSlot={(parts, { className }) => (
        <form.AppForm>
          <form className={className} onSubmit={onFormSubmit(() => form.handleSubmit())}>
            {parts}
          </form>
        </form.AppForm>
      )}
      contentSlot={
        <div className="grid gap-4">
          <InputField
            form={form}
            name="name"
            label="Name"
            required
            autoFocus
            placeholder="Shop"
            validators={{ onChange: ({ value }) => (value.trim() === '' ? 'Give the upstream a name.' : undefined) }}
          />
          <InputField
            form={form}
            name="url"
            label="GraphQL endpoint"
            required
            type="url"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="https://api.example.com/graphql"
            validators={{ onChange: ({ value }) => checkUrl(value) }}
          />
          <form.Field name="headers" mode="array">
            {(headersField) => (
              <fieldset className="grid gap-3">
                <legend className="font-medium text-foreground text-sm">Headers</legend>
                <p className="text-foreground/60 text-sm">
                  Sent with every request to this upstream, from the server only. A value may be a reference such as{' '}
                  <code className="font-mono">{ENV_REFERENCE_EXAMPLE}</code>, read from the server’s environment, so the
                  secret is never stored here.
                </p>
                {headersField.state.value.map((_header, index) => (
                  <div
                    // Rows have no id of their own; the index is what the form addresses them by.
                    // biome-ignore lint/suspicious/noArrayIndexKey: the form names each row by its place.
                    key={index}
                    className="flex items-end gap-2"
                  >
                    <FieldRow
                      className="min-w-0 flex-1"
                      contentSlot={
                        <>
                          <InputField
                            form={form}
                            name={`headers[${index}].name`}
                            label="Header"
                            placeholder="Authorization"
                            autoCapitalize="none"
                            spellCheck={false}
                          />
                          <InputField
                            form={form}
                            name={`headers[${index}].value`}
                            label="Value"
                            placeholder={`Bearer ${ENV_REFERENCE_EXAMPLE}`}
                            autoCapitalize="none"
                            spellCheck={false}
                          />
                        </>
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove header ${index + 1}`}
                      iconSlot={<Trash2 />}
                      onClick={() => headersField.removeValue(index)}
                    />
                  </div>
                ))}
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    iconSlot={<Plus />}
                    content="Add header"
                    onClick={() => headersField.pushValue({ name: '', value: '' })}
                  />
                </div>
              </fieldset>
            )}
          </form.Field>
          {serverError === undefined ? null : (
            <Alert variant="destructive" title="Not saved" description={serverError} />
          )}
        </div>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton
            variant={isEdit ? undefined : 'info'}
            isEdit={isEdit}
            requireChanges={isEdit}
            createLabel="Add upstream"
            loadingLabel={isEdit ? undefined : 'Adding…'}
          />
        </>
      )}
    />
  );
}
