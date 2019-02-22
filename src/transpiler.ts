import { simple } from 'acorn-walk/dist/walk'
import { generate } from 'astring'
import * as es from 'estree'
import { GLOBAL, GLOBAL_KEY_TO_ACCESS_NATIVE_STORAGE } from './constants'
import { transform } from './transformer'
// import * as constants from "./constants";
// import * as errors from "./interpreter-errors";
import { AllowedDeclarations, Value } from './types'
import * as create from './utils/astCreator'
import * as random from './utils/random'
// import * as rttc from "./utils/rttc";

type StorageLocations = 'builtins' | 'globals' | 'operators' | 'properTailCalls'

let NATIVE_STORAGE: {
  builtins: Map<string, Value>
  globals: Map<string, { kind: AllowedDeclarations; value: Value }>
  operators: Map<string, (...operands: Value[]) => Value>
}

let usedIdentifiers: Set<string>

function getUnqiueId() {
  let uniqueId = `$$unique${random.integer()}`
  while (usedIdentifiers.has(uniqueId)) {
    uniqueId += random.character()
  }
  usedIdentifiers.add(uniqueId)
  return uniqueId
}

let nativeStorageUniqueId: string
let contextId: number

function createStorageLocationAstFor(type: StorageLocations): es.MemberExpression {
  return create.memberExpression(
    {
      type: 'MemberExpression',
      object: create.identifier(nativeStorageUniqueId),
      property: create.literal(contextId),
      computed: true
    },
    type
  )
}

function createGetFromStorageLocationAstFor(name: string, type: StorageLocations): es.Expression {
  return create.callExpression(create.memberExpression(createStorageLocationAstFor(type), 'get'), [
    create.literal(name)
  ])
}

function createStatementAstToStoreBackCurrentlyDeclaredGlobal(
  name: string,
  kind: AllowedDeclarations
): es.ExpressionStatement {
  return create.expressionStatement(
    create.callExpression(create.memberExpression(createStorageLocationAstFor('globals'), 'set'), [
      create.literal(name),
      create.objectExpression([
        create.property('kind', create.literal(kind)),
        create.property('value', create.identifier(name))
      ])
    ])
  )
}

function createStatementsToDeclareBuiltins() {
  const statements = []
  for (const builtinName of NATIVE_STORAGE[contextId].builtins.keys()) {
    statements.push(
      create.constantDeclaration(
        builtinName,
        createGetFromStorageLocationAstFor(builtinName, 'builtins')
      )
    )
  }
  return statements
}

function createStatementsToDeclarePreviouslyDeclaredGlobals() {
  const statements = []
  for (const [name, valueWrapper] of NATIVE_STORAGE[contextId].globals.entries()) {
    const unwrappedValueAst = create.memberExpression(
      createGetFromStorageLocationAstFor(name, 'globals'),
      'value'
    )
    statements.push(create.declaration(name, valueWrapper.kind, unwrappedValueAst))
  }
  return statements
}

function createStatementsToStorePreviouslyDeclaredLetGlobals() {
  const statements = []
  for (const [name, valueWrapper] of NATIVE_STORAGE[contextId].globals.entries()) {
    if (valueWrapper.kind === 'let') {
      statements.push(createStatementAstToStoreBackCurrentlyDeclaredGlobal(name, 'let'))
    }
  }
  return statements
}

function createStatementsToStoreCurrentlyDeclaredGlobals(program: es.Program) {
  const statements = []
  for (const statement of program.body) {
    if (statement.type === 'VariableDeclaration') {
      const name = (statement.declarations[0].id as es.Identifier).name
      const kind = statement.kind as AllowedDeclarations
      statements.push(createStatementAstToStoreBackCurrentlyDeclaredGlobal(name, kind))
    }
  }
  return statements
}

/**
 * Transforms all arrow functions
 * (arg1, arg2, ...) => { statement1; statement2; return statement3; }
 *
 * to
 *
 * <NATIVE STORAGE>.properTailCalls.wrap((arg1, arg2, ...) => {
 *   statement1;statement2;return statement3;
 * })
 *
 * to allow for iterative processes to take place
 */

function wrapArrowFunctionsToAllowNormalCalls(program: es.Program) {
  simple(program, {
    ArrowFunctionExpression(node) {
      const originalNode = { ...node }
      node.type = 'CallExpression'
      const transformedNode = node as es.CallExpression
      transformedNode.arguments = [originalNode as es.ArrowFunctionExpression]
      transformedNode.callee = create.memberExpression(
        createStorageLocationAstFor('properTailCalls'),
        'wrap'
      )
    }
  })
}

/**
 * Transforms all return statements to return an intermediate value
 * return nonFnCall + 1;
 *  =>
 * return {isTail: false, value: nonFnCall + 1};
 *
 * return fnCall(arg1, arg2);
 * => return {isTail: true, function: fnCall, arguments: [arg1, arg2]}
 *
 * conditional and logical expressions will be recursively looped through as well
 */
function transformReturnStatementsToAllowProperTailCalls(program: es.Program) {
  simple(program, {
    ReturnStatement(node: es.ReturnStatement) {
      function transformLogicalExpression(expression: es.Expression): es.Expression {
        switch (expression.type) {
          case 'LogicalExpression':
            return {
              type: 'LogicalExpression',
              operator: expression.operator,
              left: expression.left,
              right: transformLogicalExpression(expression.right)
            }
          case 'ConditionalExpression':
            return {
              type: 'ConditionalExpression',
              test: expression.test,
              consequent: transformLogicalExpression(expression.consequent),
              alternate: transformLogicalExpression(expression.alternate)
            } as es.ConditionalExpression
          case 'CallExpression':
            expression = expression as es.CallExpression
            return create.objectExpression([
              create.property('isTail', create.literal(true)),
              create.property('function', expression.callee as es.Expression),
              create.property('arguments', {
                type: 'ArrayExpression',
                elements: expression.arguments
              })
            ])
          default:
            return create.objectExpression([
              create.property('isTail', create.literal(false)),
              create.property('value', expression)
            ])
        }
      }

      node.argument = transformLogicalExpression(node.argument!)
    }
  })
}

function refreshLatestNatives(program: es.Program) {
  NATIVE_STORAGE = GLOBAL[GLOBAL_KEY_TO_ACCESS_NATIVE_STORAGE]
  usedIdentifiers = getAllIdentifiersUsed(program)
  nativeStorageUniqueId = getUnqiueId()
}

function getAllIdentifiersUsed(program: es.Program) {
  const identifiers = new Set<string>()
  simple(program, {
    Identifier(node: es.Identifier) {
      identifiers.add(node.name)
    }
  })
  return identifiers
}

function getStatementsToPrepend() {
  return [
    ...createStatementsToDeclareBuiltins(),
    ...createStatementsToDeclarePreviouslyDeclaredGlobals()
  ]
}

function getStatementsToAppend(program: es.Program): es.Statement[] {
  return [
    ...createStatementsToStorePreviouslyDeclaredLetGlobals(),
    ...createStatementsToStoreCurrentlyDeclaredGlobals(program)
  ]
}

/**
 * statement1;
 * statement2;
 * ...
 * const a = 1; //lastStatement example 1 (should give undefined)
 * 1 + 1; //lastStatement example 2 (should give 2)
 * b = fun(5); //lastStatement example 3 (should set b to fun(5))
 * if (true) { true; } else { false; } //lastStatement example 4 (should give true)
 * for (let i = 0; i < 5; i = i + 1) { i; } //lastStatement example 5 (should give 4)
 *
 * We want to preserve the last evaluated statement's result to return back, so
 * for const/let declarations we simply don't change anything, and return undefined
 * at the end.
 *
 * For others, we will convert it into a string, wrap it in an eval, and store
 * the result in a temporary variable. e.g.
 *
 * const tempVar = eval("1+1;");
 * const tempVar = eval("if (true) { true; } else { false; }");
 * etc etc...
 * now at the end of all the appended statements we can do
 * return tempVar;
 */

function splitLastStatementIntoStorageOfResultAndAccessorPair(
  lastStatement: es.Statement
): es.Statement[] {
  if (lastStatement.type === 'VariableDeclaration') {
    return [lastStatement, create.returnStatement(create.identifier('undefined'))]
  }
  const uniqueIdentifier = getUnqiueId()
  const lastStatementAsCode = generate(lastStatement)
  const uniqueDeclarationToStoreLastStatementResult = create.constantDeclaration(
    uniqueIdentifier,
    create.callExpression(create.identifier('eval'), [create.literal(lastStatementAsCode)])
  )
  const returnStatementToReturnLastStatementResult = create.returnStatement(
    create.identifier(uniqueIdentifier)
  )
  return [uniqueDeclarationToStoreLastStatementResult, returnStatementToReturnLastStatementResult]
}

export function transpile(untranformedProgram: es.Program, id: number) {
  contextId = id
  refreshLatestNatives(untranformedProgram)
  const program: es.Program = transform(untranformedProgram)
  const statements = program.body as es.Statement[]
  if (statements.length > 0) {
    transformReturnStatementsToAllowProperTailCalls(program)
    wrapArrowFunctionsToAllowNormalCalls(program)
    const declarationToAccessNativeStorage = create.constantDeclaration(
      nativeStorageUniqueId,
      create.identifier(GLOBAL_KEY_TO_ACCESS_NATIVE_STORAGE)
    )
    const statementsToPrepend = getStatementsToPrepend()
    const statementsToAppend = getStatementsToAppend(program)
    const lastStatement = statements.pop() as es.Statement
    const [
      uniqueDeclarationToStoreLastStatementResult,
      returnStatementToReturnLastStatementResult
    ] = splitLastStatementIntoStorageOfResultAndAccessorPair(lastStatement)
    const wrapped = wrapInAnonymousFunctionToBlockExternalGlobals([
      ...statementsToPrepend,
      ...statements,
      uniqueDeclarationToStoreLastStatementResult,
      ...statementsToAppend,
      returnStatementToReturnLastStatementResult
    ])
    program.body = [declarationToAccessNativeStorage, wrapped]
  }
  return program
}

/**
 * Restricts the access of external global variables in Source
 *
 * statement;
 * statement2;
 * statement3;
 * =>
 * ((window, Number, Function, alert, ...other globals) => {
 *  statement;
 *  statement2;
 *  statement3;
 * })();
 *
 */
function wrapInAnonymousFunctionToBlockExternalGlobals(statements: es.Statement[]): es.Statement {
  function isValidIdentifier(candidate: string) {
    try {
      // tslint:disable-next-line:no-eval
      eval(`"use strict";{const ${candidate} = 1;}`)
      return true
    } catch {
      return false
    }
  }

  const globalsArray = Object.getOwnPropertyNames(GLOBAL)
  const globalsWithValidIdentifiers = globalsArray.filter(isValidIdentifier)
  const validGlobalsAsIdentifierAsts = globalsWithValidIdentifiers.map(globalName =>
    create.identifier(globalName)
  )
  return create.expressionStatement(
    create.callExpression(
      create.blockArrowFunction(validGlobalsAsIdentifierAsts, [
        create.returnStatement(create.callExpression(create.blockArrowFunction([], statements), []))
      ]),
      []
    )
  )
}
