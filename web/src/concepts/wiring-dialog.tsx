import { useState } from 'react';
import { InputField, SelectField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { FieldRow } from '@/components/field-row';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Plus, Trash2 } from '@/components/ui/icons';
import { onFormSubmit } from '@/core/forms';
import { messageOf } from '@/lib/error-message';
import { type SourceWiring, useSetWiringOverride } from './use-concepts.ts';
import { draftOf, draftProblems, type MergeKeyDraft, overrideFromDraft, type RenameDraft } from './wiring-rows.ts';

interface WiringDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The source to edit. Left out, the dialog wires a source that has no wiring yet, chosen from `sources`. */
  wiring?: SourceWiring | undefined;
  /** The sources that can be wired, when `wiring` is left out. */
  sources?: readonly string[] | undefined;
}

/** What the form holds. */
interface WiringFormValues {
  source: string;
  types: RenameDraft[];
  fields: RenameDraft[];
  mergeKeys: MergeKeyDraft[];
}

/** The shared props of the text inputs that hold GraphQL names. */
const NAME_INPUT = { autoCapitalize: 'none', autoComplete: 'off', spellCheck: false } as const;

/** A blank merge key row. */
const BLANK_MERGE_KEY: MergeKeyDraft = { type: '', keyField: '', lookupField: '', keyArg: '' };

/**
 * Edits a source's wiring: every effective rename and merge key, generated or not, can be changed or removed, and
 * new ones added. Saving stores only the difference from the generated wiring, as the source's override.
 */
export function WiringDialog({ open, onOpenChange, wiring, sources = [] }: WiringDialogProps) {
  const setOverride = useSetWiringOverride();
  const [serverError, setServerError] = useState<string | undefined>(undefined);
  const isEdit = wiring !== undefined;
  const generated = wiring?.generated ?? null;

  const defaultValues: WiringFormValues = { source: wiring?.source ?? '', ...draftOf(wiring ?? null) };
  const form = useAppForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      setServerError(undefined);
      const problems = draftProblems(value);
      if (problems.length > 0) {
        setServerError(problems.join(' '));
        return;
      }
      const override = overrideFromDraft(value.source, generated, value, wiring?.override ?? null);
      try {
        await setOverride.mutateAsync({ source: value.source, override });
        onOpenChange(false);
      } catch (error) {
        setServerError(messageOf(error) ?? 'The wiring was not saved. Try again.');
      }
    },
  });

  /**
   * One group of renames: a row per rename with its two names, a remove button, and Add.
   *
   * @param name - Which renames.
   * @param text - What the group says.
   * @param text.legend - Its name.
   * @param text.fromLabel - The source name's label.
   * @param text.fromPlaceholder - An example source name.
   * @param text.toPlaceholder - An example unified name.
   * @param text.addLabel - The add button's label.
   * @returns The fieldset.
   */
  const renameFieldset = (
    name: 'types' | 'fields',
    text: { legend: string; fromLabel: string; fromPlaceholder: string; toPlaceholder: string; addLabel: string },
  ) => (
    <form.Field name={name} mode="array">
      {(renamesField) => (
        <fieldset className="grid gap-3">
          <legend className="font-medium text-foreground text-sm">{text.legend}</legend>
          {renamesField.state.value.map((_rename, index) => (
            <div
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
                      name={`${name}[${index}].from`}
                      label={text.fromLabel}
                      placeholder={text.fromPlaceholder}
                      {...NAME_INPUT}
                    />
                    <InputField
                      form={form}
                      name={`${name}[${index}].to`}
                      label="Unified name"
                      placeholder={text.toPlaceholder}
                      {...NAME_INPUT}
                    />
                  </>
                }
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${text.legend.toLowerCase()} row ${index + 1}`}
                iconSlot={<Trash2 />}
                onClick={() => renamesField.removeValue(index)}
              />
            </div>
          ))}
          <div>
            <Button
              variant="outline"
              size="sm"
              iconSlot={<Plus />}
              content={text.addLabel}
              onClick={() => renamesField.pushValue({ from: '', to: '' })}
            />
          </div>
        </fieldset>
      )}
    </form.Field>
  );

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title={isEdit ? `Wiring for ${wiring.source}` : 'Wire a source'}
      description="What the unified API calls this source's types and fields, and how it fetches an entity from it by key. Change or remove any entry, generated or not, or add your own: saving stores the difference from the generated wiring."
      hasUnsavedChanges={() => form.state.isDefaultValue === false}
      wrapperSlot={(parts, { className }) => (
        <form.AppForm>
          <form className={className} onSubmit={onFormSubmit(() => form.handleSubmit())}>
            {parts}
          </form>
        </form.AppForm>
      )}
      contentSlot={
        <div className="grid gap-6">
          {isEdit ? null : (
            <SelectField
              form={form}
              name="source"
              label="Source"
              required
              placeholder="Choose an upstream"
              options={sources.map((source) => ({ value: source, label: source }))}
              validators={{ onChange: ({ value }) => (value === '' ? 'Choose the source to wire.' : undefined) }}
            />
          )}
          {renameFieldset('types', {
            legend: 'Type renames',
            fromLabel: 'Source type',
            fromPlaceholder: 'Group',
            toPlaceholder: 'Team',
            addLabel: 'Add type rename',
          })}
          {renameFieldset('fields', {
            legend: 'Field renames',
            fromLabel: 'Source field (Type.field)',
            fromPlaceholder: 'Group.label',
            toPlaceholder: 'name',
            addLabel: 'Add field rename',
          })}
          <form.Field name="mergeKeys" mode="array">
            {(mergeKeysField) => (
              <fieldset className="grid gap-3">
                <legend className="font-medium text-foreground text-sm">Merge keys</legend>
                <p className="text-foreground/60 text-sm">
                  The unified type, the field that identifies it, and the root field that fetches it by that key. Name
                  the argument when it is not called like the key field.
                </p>
                {mergeKeysField.state.value.map((_mergeKey, index) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: the form names each row by its place.
                    key={index}
                    className="flex items-end gap-2"
                  >
                    <FieldRow
                      className="min-w-0 flex-1"
                      perRow={3}
                      contentSlot={
                        <>
                          <InputField
                            form={form}
                            name={`mergeKeys[${index}].type`}
                            label="Type"
                            placeholder="Team"
                            {...NAME_INPUT}
                          />
                          <InputField
                            form={form}
                            name={`mergeKeys[${index}].keyField`}
                            label="Key field"
                            placeholder="id"
                            {...NAME_INPUT}
                          />
                          <InputField
                            form={form}
                            name={`mergeKeys[${index}].lookupField`}
                            label="Lookup field"
                            placeholder="team"
                            {...NAME_INPUT}
                          />
                          <InputField
                            form={form}
                            name={`mergeKeys[${index}].keyArg`}
                            label="Key argument"
                            placeholder="Same as the key field"
                            {...NAME_INPUT}
                          />
                        </>
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove merge key row ${index + 1}`}
                      iconSlot={<Trash2 />}
                      onClick={() => mergeKeysField.removeValue(index)}
                    />
                  </div>
                ))}
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    iconSlot={<Plus />}
                    content="Add merge key"
                    onClick={() => mergeKeysField.pushValue({ ...BLANK_MERGE_KEY })}
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
          <form.SubmitButton isEdit requireChanges={isEdit} editLabel="Save override" loadingLabel="Saving…" />
        </>
      )}
    />
  );
}
