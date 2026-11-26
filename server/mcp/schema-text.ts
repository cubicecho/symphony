// What get_schema and search_schema say about an upstream's cached schema.
import {
  type GraphQLArgument,
  type GraphQLField,
  type GraphQLInputField,
  type GraphQLNamedType,
  type GraphQLSchema,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isIntrospectionType,
  isObjectType,
  isSpecifiedScalarType,
  isUnionType,
  printType,
} from 'graphql';
import { notFound } from '../core/errors.ts';
import { didYouMean } from './answers.ts';

/** What separates a search line's signature from its description. */
const DESCRIPTION_SEPARATOR = '  — ';

/** The SDL keyword each kind of named type is declared with. */
const KIND_KEYWORDS: { test: (type: GraphQLNamedType) => boolean; keyword: string }[] = [
  { test: isObjectType, keyword: 'type' },
  { test: isInterfaceType, keyword: 'interface' },
  { test: isUnionType, keyword: 'union' },
  { test: isEnumType, keyword: 'enum' },
  { test: isInputObjectType, keyword: 'input' },
];

/** What a search found: the matching lines, and how many more there were past the limit. */
export interface SchemaSearch {
  lines: string[];
  /** Matches left out because the limit was reached. */
  omitted: number;
}

/**
 * Lists the types an agent may ask about: everything but introspection types and the built-in scalars.
 *
 * @param schema - The upstream's schema.
 * @returns The types, in the schema's order.
 */
function ownTypes(schema: GraphQLSchema): GraphQLNamedType[] {
  return Object.values(schema.getTypeMap()).filter(
    (type) => isIntrospectionType(type) === false && isSpecifiedScalarType(type) === false,
  );
}

/**
 * Lists the named types one type points at directly.
 *
 * @param type - The type.
 * @returns Its fields' and arguments' types, union members and interfaces, each once.
 */
function referencedTypes(type: GraphQLNamedType): GraphQLNamedType[] {
  const found: GraphQLNamedType[] = [];
  const isComposite = isObjectType(type) || isInterfaceType(type);
  if (isComposite) {
    found.push(...type.getInterfaces());
    for (const field of Object.values(type.getFields())) {
      found.push(getNamedType(field.type), ...field.args.map((arg) => getNamedType(arg.type)));
    }
  }
  if (isInputObjectType(type)) {
    found.push(...Object.values(type.getFields()).map((field) => getNamedType(field.type)));
  }
  if (isUnionType(type)) {
    found.push(...type.getTypes());
  }
  return [...new Set(found)];
}

/**
 * Prints one type and the types it references directly.
 *
 * @param schema - The upstream's schema.
 * @param name - The type's name; `Query` and `Mutation` work too. Exact case first, then any case.
 * @returns SDL: the type first, then its neighbours, built-in scalars left out.
 * @throws NOT_FOUND, naming close type names, when there is no such type.
 */
export function printTypeWithNeighbours(schema: GraphQLSchema, name: string): string {
  const types = ownTypes(schema);
  const wanted = name.trim();
  const type = schema.getType(wanted) ?? types.find((one) => one.name.toLowerCase() === wanted.toLowerCase()) ?? null;
  if (type === null || isIntrospectionType(type)) {
    const names = types.map((one) => one.name);
    throw notFound(`No type "${wanted}" in this schema.${didYouMean(wanted, names)}`);
  }
  const neighbours = referencedTypes(type).filter(
    (one) => one !== type && isIntrospectionType(one) === false && isSpecifiedScalarType(one) === false,
  );
  return [type, ...neighbours].map((one) => printType(one)).join('\n\n');
}

/**
 * Writes an argument list as SDL, without default values.
 *
 * @param args - The arguments.
 * @returns `(first: Int, status: OrderStatus)`, or an empty string for none.
 */
function printArgs(args: readonly GraphQLArgument[]): string {
  if (args.length === 0) {
    return '';
  }
  return `(${args.map((arg) => `${arg.name}: ${String(arg.type)}`).join(', ')})`;
}

/**
 * Joins a signature and a description into one search line.
 *
 * @param signature - The SDL-like signature.
 * @param description - Its description, if any.
 * @returns The line, the description folded onto it.
 */
function searchLine(signature: string, description: string | null | undefined): string {
  const folded = (description ?? '').replace(/\s+/g, ' ').trim();
  return folded === '' ? signature : `${signature}${DESCRIPTION_SEPARATOR}${folded}`;
}

/**
 * Says whether any of some texts contain the search text.
 *
 * @param needle - The search text, lower case.
 * @param texts - Names and descriptions.
 * @returns True on the first one that contains it.
 */
function containsText(needle: string, texts: (string | null | undefined)[]): boolean {
  return texts.some((text) => (text ?? '').toLowerCase().includes(needle));
}

/**
 * Writes the lines one type contributes to a search.
 *
 * @param type - The type.
 * @param needle - The search text, lower case.
 * @returns Its own line when its name or description matches, then each matching field, argument or value.
 */
function typeMatches(type: GraphQLNamedType, needle: string): string[] {
  const lines: string[] = [];
  const keyword = KIND_KEYWORDS.find((kind) => kind.test(type))?.keyword ?? 'scalar';
  if (containsText(needle, [type.name, type.description])) {
    lines.push(searchLine(`${keyword} ${type.name}`, type.description));
  }
  const isComposite = isObjectType(type) || isInterfaceType(type);
  if (isComposite) {
    for (const field of Object.values<GraphQLField<unknown, unknown>>(type.getFields())) {
      const argTexts = field.args.flatMap((arg) => [arg.name, arg.description]);
      if (containsText(needle, [field.name, field.description, ...argTexts])) {
        const signature = `${type.name}.${field.name}${printArgs(field.args)}: ${String(field.type)}`;
        lines.push(searchLine(signature, field.description));
      }
    }
  }
  if (isInputObjectType(type)) {
    for (const field of Object.values<GraphQLInputField>(type.getFields())) {
      if (containsText(needle, [field.name, field.description])) {
        lines.push(searchLine(`${type.name}.${field.name}: ${String(field.type)}`, field.description));
      }
    }
  }
  if (isEnumType(type)) {
    for (const value of type.getValues()) {
      if (containsText(needle, [value.name, value.description])) {
        lines.push(searchLine(`${type.name}.${value.name}`, value.description));
      }
    }
  }
  return lines;
}

/**
 * Finds the types, fields, arguments and enum values whose name or description contains a text.
 *
 * @param schema - The upstream's schema.
 * @param text - What to look for, in any case.
 * @param limit - Most lines to return.
 * @returns The matching lines, and how many were left out.
 */
export function searchSchema(schema: GraphQLSchema, text: string, limit: number): SchemaSearch {
  const needle = text.trim().toLowerCase();
  const all = ownTypes(schema).flatMap((type) => typeMatches(type, needle));
  return { lines: all.slice(0, limit), omitted: Math.max(0, all.length - limit) };
}
