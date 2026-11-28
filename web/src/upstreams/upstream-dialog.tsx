import { useState } from 'react';
import { InputField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { FieldRow } from '@/components/field-row';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Plus, Trash2 } from '@/components/ui/icons';
import { onFormSubmit } from '@/core/forms';
import { messageOf } from '@/lib/error-message';
import {
  type DiscoveredUpstream,
  type Upstream,
  useAddDiscoveredUpstream,
  useAddUpstream,
  useUpdateUpstream,
} from './use-upstreams.ts';

/** The schemes an upstream's URL may use. */
const WEB_PROTOCOLS = ['http:', 'https:'];
/** A header value that names a server environment variable instead of holding the secret. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: the server's reference syntax, shown as typed.
const ENV_REFERENCE_EXAMPLE = '${env:SYMPHONY_SHOP_TOKEN}';
/** The longest upstream name the server takes. */
const MAX_NAME_CHARS = 60;

interface UpstreamDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The upstream to edit. Left out, the dialog adds one. */
  upstream?: Upstream | undefined;
  /** An API found on the LAN to add. Its address is the one it advertises, and can't be changed here. */
  discovered?: DiscoveredUpstream | undefined;
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
 * A name the server takes, made from what a found API calls itself.
 *
 * @param found - The found API.
 * @returns Its title, or the last part of its service name, with what a name can't hold turned into dashes.
 */
function suggestedName(found: DiscoveredUpstream): string {
  const base = found.title ?? found.serviceName.split('/').at(-1) ?? found.serviceName;
  return base
    .replace(/[^A-Za-z0-9 _.-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, MAX_NAME_CHARS)
    .trim();
}

/**
 * Checks that every header a found API requires has a value.
 *
 * @param headers - The rows as typed.
 * @param required - The header names the API asks for.
 * @returns Why it is refused, or undefined.
 */
function checkRequiredHeaders(headers: HeaderDraft[], required: readonly string[]): string | undefined {
  const given = new Set(headers.filter((header) => header.value.trim() !== '').map((header) => header.name.trim()));
  const missing = required.filter((name) => given.has(name) === false);
  return missing.length === 0 ? undefined : `This API needs a value for ${missing.join(', ')}.`;
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

/**
 * What the form starts with.
 *
 * @param upstream - The upstream being edited, if any.
 * @param discovered - The found API being added, if any.
 * @returns The draft.
 */
function draftOf(upstream: Upstream | undefined, discovered: DiscoveredUpstream | undefined): UpstreamDraft {
  if (discovered) {
    return {
      name: suggestedName(discovered),
      url: discovered.url,
      headers: discovered.requiredHeaders.map((name) => ({ name, value: '' })),
    };
  }
  return {
    name: upstream?.name ?? '',
    url: upstream?.url ?? '',
    headers: upstream?.headers.map(({ name, value }) => ({ name, value })) ?? [],
  };
}

/**
 * The dialog's title and the line under it.
 *
 * @param upstream - The upstream being edited, if any.
 * @param discovered - The found API being added, if any.
 * @returns Both; the description is undefined when editing.
 */
function headingOf(
  upstream: Upstream | undefined,
  discovered: DiscoveredUpstream | undefined,
): { title: string; description: string | undefined } {
  if (discovered) {
    return {
      title: `Add ${discovered.title ?? discovered.serviceName}`,
      description: `Found on the network, advertised by ${discovered.host}. If its address changes, the upstream follows it.`,
    };
  }
  if (upstream) {
    return { title: `Edit ${upstream.name}`, description: undefined };
  }
  return {
    title: 'Add upstream',
    description: 'A GraphQL API for modules to read. Symphony introspects it as soon as it is added.',
  };
}

/** Adds an upstream (typed in, or found on the LAN), or changes one's name, address and headers. */
export function UpstreamDialog({ open, onOpenChange, upstream, discovered }: UpstreamDialogProps) {
  const addUpstream = useAddUpstream();
  const addDiscovered = useAddDiscoveredUpstream();
  const updateUpstream = useUpdateUpstream();
  const [serverError, setServerError] = useState<string | undefined>(undefined);
  const isEdit = upstream !== undefined;
  const isDiscovered = discovered !== undefined;

  const defaultValues = draftOf(upstream, discovered);
  const heading = headingOf(upstream, discovered);
  const form = useAppForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      setServerError(undefined);
      const fields = { name: value.name.trim(), url: value.url.trim(), headers: cleanHeaders(value.headers) };
      const headerProblem = isDiscovered ? checkRequiredHeaders(fields.headers, discovered.requiredHeaders) : undefined;
      if (headerProblem !== undefined) {
        setServerError(headerProblem);
        return;
      }
      try {
        if (isDiscovered) {
          await addDiscovered.mutateAsync({ key: discovered.key, name: fields.name, headers: fields.headers });
        } else if (isEdit) {
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
      title={heading.title}
      description={heading.description}
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
            disabled={isDiscovered}
            description={isDiscovered ? 'The address this API advertises.' : undefined}
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
