import defu from 'defu';
import { generateTransform, RolldownString, withMagicString } from 'rolldown-string';
import { MagicStringAST } from 'magic-string-ast';
import { getBabelParserOptions, getLang } from 'ast-kit';

import * as parser from '@babel/parser';
import * as t from '@babel/types';
import {
  defaultOptions,
  earlyPruneRegex,
  type Options,
  initPluginState,
  UnpluginPluginState,
  embedJSON,
  functionVisitor,
  MetadatableFunction,
  getVisibilityScope,
} from './common.ts';
import type { UnpluginBuildContext, UnpluginContext, UnpluginFactory } from 'unplugin';
import _traverse, { type NodePath } from '@babel/traverse';
import { FORMAT_VERSION } from 'tinyest';
import { transpileFn } from 'tinyest-for-wgsl';

// I love CommonJS 💔
let traverse = _traverse;
if (typeof (traverse as any).default === 'function') {
  traverse = (traverse as any).default as typeof traverse;
}

const fnWrapperTemplate = (fnCode: string, metadata: string) =>
  `/* #__PURE__ */ (($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = (${fnCode}), ${metadata}) && $.f)({}))`;

function assignMetadata(
  this: UnpluginPluginState,
  path: NodePath<MetadatableFunction>,
  name: string | undefined,
  ast: ReturnType<typeof transpileFn>,
): void {
  const metadata = `{
    v: ${FORMAT_VERSION},
    name: ${name ? `"${name}"` : 'undefined'},
    ast: ${embedJSON(ast)},
    externals: () => ({${ast.externalNames
      .map((e) => (e === 'this' ? '"this": this' : e))
      .join(', ')}}),
  }`;

  const visibility = t.isFunctionDeclaration(path.node)
    ? getVisibilityScope(this, path as NodePath<t.FunctionDeclaration>)
    : undefined;

  this.magicString.prependRight(
    path.node.start ?? 0,
    '/* #__PURE__ */ (($ => (globalThis.__TYPEGPU_META__ ??= new WeakMap()).set($.f = (',
  );
  this.magicString.appendLeft(path.node.end ?? 0, `), ${metadata}) && $.f)({}))`);

  if (visibility) {
    // Hoisting the declaration to the top of the scope
    const insertPos = visibility.scope.node.body[0]
      ? (visibility.scope.node.body[0].start ?? 0)
      : (visibility.scope.node.start ?? 0) + 1;

    let nodeToUpdate: t.Node = path.node;

    this.magicString.prependRight(path.node.start ?? 0, `const ${visibility.name} = `);
    this.magicString.appendLeft(path.node.end ?? 0, ';\n\n');

    if (t.isExportNamedDeclaration(path.parent)) {
      nodeToUpdate = path.parent;
    }

    if ((path.node.start ?? 0) > insertPos) {
      this.magicString.moveNode(nodeToUpdate, insertPos);
    }
  }
}

function wrapInAutoName(
  this: UnpluginPluginState,
  path: NodePath<t.Expression>,
  name: string,
): void {
  this.magicString
    .appendLeft(path.node.start ?? 0, '((globalThis.__TYPEGPU_AUTONAME__ ?? (a => a))(')
    .prependRight(path.node.end ?? 0, `, "${name}"))`);
}

function replaceWithAssignmentOverload(
  this: UnpluginPluginState,
  path: NodePath<t.AssignmentExpression>,
  runtimeFn: string,
): void {
  const lhs = this.magicString.sliceNode(path.node.left);
  const rhs = this.magicString.sliceNode(path.node.right);
  this.magicString.overwriteNode(path.node, `${lhs} = ${runtimeFn}(${lhs}, ${rhs})`);
}

function replaceWithBinaryOverload(
  this: UnpluginPluginState,
  path: NodePath<t.BinaryExpression>,
  runtimeFn: string,
): void {
  const lhs = this.magicString.sliceNode(path.node.left);
  const rhs = this.magicString.sliceNode(path.node.right);
  this.magicString.overwriteNode(path.node, `${runtimeFn}(${lhs}, ${rhs})`);
}

export const unpluginFactory: UnpluginFactory<Options> = (rawOptions) => {
  const options = defu(rawOptions, defaultOptions);

  return {
    name: 'unplugin-typegpu' as const,
    enforce: options.enforce,
    transform: {
      filter: options.earlyPruning
        ? {
            id: options,
            code: earlyPruneRegex,
          }
        : {
            id: options,
          },
      handler: withMagicString(function (
        this: UnpluginBuildContext & UnpluginContext,
        str: RolldownString,
        id: string,
      ) {
        let ast: parser.ParseResult;
        try {
          ast = parser.parse(
            str.toString(),
            getBabelParserOptions(getLang(id), {
              sourceType: 'module',
              allowReturnOutsideFunction: true,
            }),
          );
        } catch (cause) {
          console.warn(
            `[unplugin-typegpu] Failed to parse ${id}. Cause: ${
              typeof cause === 'object' && cause && 'message' in cause ? cause.message : cause
            }`,
          );
          return undefined;
        }

        const magicString = new MagicStringAST(str);

        const state = {
          filename: id,
          magicString,
          opts: options,
        } as UnpluginPluginState;

        initPluginState(state, {
          warn: (message) => this.warn(message),
          assignMetadata,
          wrapInAutoName,
          replaceWithAssignmentOverload,
          replaceWithBinaryOverload,
        });

        traverse(ast, functionVisitor, undefined, state);

        console.log(generateTransform(magicString, id)?.code);
      }),
    },
  };
};
