import { parseScript, Program } from 'esprima';
import { Directive, ModuleDeclaration, Expression, FunctionDeclaration, Pattern, Statement } from 'estree';
import fs from 'fs';

export class JavascriptSyntaxError extends Error {
  code: string;
  fileName: string;

  constructor(msg: string, fileName: string, code: string) {
    super(msg);
    Object.setPrototypeOf(this, JavascriptSyntaxError.prototype);
    this.fileName = fileName;
    this.code = code;
  }
}

export function checkedParseScript(filePath: string): Program {
  const code = fs.readFileSync(filePath, 'utf-8');
  try {
    return parseScript(code);
  } catch (e) {
    throw new JavascriptSyntaxError(e.message, filePath, code);
  }
}

export function findFreeVariables(program: Program): Set<string> {
  const functionDeclarations = program.body.filter(node => node.type === 'FunctionDeclaration') as Array<FunctionDeclaration>;
  const globalVariables = new Set(functionDeclarations.map(node => node.id?.name)) as Set<string>;
  // TODO: collect variable declarations too
  // const globalVariableReferences = new Set(iterVariableNames(program.body));
  const freeVariables = new Set<string>();
  for (const node of functionDeclarations) {
    for (const name of iterStatement(node)) {
      if (!globalVariables.has(name)) {
        freeVariables.add(name);
      }
    }
  }
  return freeVariables;

  function* iterStatement(node: Statement): Iterable<string> {
    switch (node.type) {
      case 'FunctionDeclaration':
        const locals = new Set<string>();
        if (node.id) {
          locals.add(node.id.name);
        }
        for (const param of node.params) {
          for (const name of iterPatternNames(param)) {
            locals.add(name);
          }
        }
        // FIXME: this doesn't account for names that are used before they are declared
        for (const block of node.body.body) {
          for (const name of iterDeclaredNames(block)) {
            locals.add(name);
          }
        }
        for (const child of node.body.body) {
          for (const name of iterStatement(child)) {
            if (!locals.has(name)) {
              yield name;
            }
          }
        }
        break;
      case 'BlockStatement':
        for (const child of node.body) {
          yield* iterStatement(child);
        }
        break;
      case 'DoWhileStatement':
        yield* iterStatement(node.body);
        yield* iterExpression(node.test);
        break;
      case 'ExpressionStatement':
        yield* iterExpression(node.expression);
        break;
      case 'ForStatement':
        // FIXME: build local context
        // TODO: if (node.init) { yield* iterExpression(node.init); }
        if (node.test) { yield* iterExpression(node.test); }
        if (node.update) { yield* iterExpression(node.update); }
        yield* iterStatement(node.body);
        break;
      case 'ForInStatement':
        // FIXME: build local context
        // TODO: yield* iterExpression(node.left);
        yield* iterExpression(node.right);
        yield* iterStatement(node.body);
        break;
      case 'IfStatement':
        yield* iterExpression(node.test);
        yield* iterStatement(node.consequent);
        if (node.alternate) {
          yield* iterStatement(node.alternate);
        }
        break;
      case 'LabeledStatement':
        yield* iterStatement(node.body);
        break;
      case 'ReturnStatement':
        if (node.argument) {
          yield* iterExpression(node.argument);
        }
        break;
      case 'VariableDeclaration':
        for (const decl of node.declarations) {
          if (decl.init) {
            yield* iterExpression(decl.init);
          }
        }
        break;
      case 'WhileStatement':
        yield* iterExpression(node.test);
        yield* iterStatement(node.body);
        break;
      case 'DebuggerStatement':
      case 'EmptyStatement':
      case 'BreakStatement':
      case 'ContinueStatement':
        break;
      default:
        console.warn('unimplemented statement', node);
        break;
    }
    // TODO: WithStatement |  SwitchStatement | ThrowStatement | TryStatement
    // TODO: ForInStatement | ForOfStatement | Declaration
  }

  function* iterExpression(node: Expression): Iterable<string> {
    switch (node.type) {
      case 'AssignmentExpression':
        yield* iterExpression(node.right);
        break;
      case 'BinaryExpression':
        yield* iterExpression(node.left);
        yield* iterExpression(node.right);
        break;
      case 'CallExpression':
        if (node.callee.type !== 'Super') {
          yield* iterExpression(node.callee);
        }
        for (const arg of node.arguments) {
          if (arg.type !== 'SpreadElement') {
            yield* iterExpression(arg);
          }
        }
        break;
      case 'MemberExpression':
        if (node.object.type !== 'Super') {
          yield* iterExpression(node.object);
        }
        break;
      case 'Identifier':
        yield node.name;
        break;
      case 'Literal':
        break;
      default:
        console.warn('unimplemented expression', node);
        break;
    }
    // TODO: ThisExpression | ArrayExpression | ObjectExpression | FunctionExpression
    // TODO: ArrowFunctionExpression | YieldExpression | UnaryExpression
    // TODO: UpdateExpression
    // TODO: LogicalExpression | ConditionalExpression
    // TODO: NewExpression | SequenceExpression | TemplateLiteral
    // TODO: TaggedTemplateExpression | ClassExpression | MetaProperty
    // TODO: AwaitExpression | ImportExpression | ChainExpression
  }

  function* iterDeclaredNames(node: Statement): Iterable<string> {
    switch (node.type) {
      case 'FunctionDeclaration':
        if (node.id) {
          yield node.id.name;
        }
        break;
      case 'VariableDeclaration':
        for (const decl of node.declarations) {
          yield* iterPatternNames(decl.id);
          break;
        }
    }
  }

  function* iterPatternNames(node: Pattern): Iterable<string> {
    switch (node.type) {
      case 'Identifier':
        yield node.name;
        break;
      case 'ObjectPattern':
        for (const prop of node.properties) {
          if (prop.type === 'Property') {
            yield* iterPatternNames(prop.value);
          } else {
            yield* iterPatternNames(prop.argument);
          }
        }
        break;
      case 'ArrayPattern':
        for (const elem of node.elements as Array<Pattern>) {
          yield* iterPatternNames(elem);
        }
        break;
      case 'RestElement':
        yield* iterPatternNames(node.argument);
        break;
      case 'AssignmentPattern':
        yield* iterPatternNames(node.left);
        break;
      // TODO: MemberExpression ?
    }
  }
}

// TODO: very incomplete
export function findP5MemberReferences(program: Program): Set<string> {
  const references = new Set<string>(iterProgram(program));
  return references;

  function* iterProgram(program: Program): Iterable<string> {
    for (const block of program.body) {
      yield* iterStatement(block);
    }
  }
  function* iterStatement(node: Directive | Statement | ModuleDeclaration): Iterable<string> {
    switch (node.type) {
      case 'FunctionDeclaration':
        for (const child of node.body.body) {
          yield* iterStatement(child);
        }
        break;
      case 'VariableDeclaration':
        for (const decl of node.declarations) {
          if (decl.init) {
            yield* iterExpression(decl.init);
          }
        }
        break;
      case 'ExpressionStatement':
        yield* iterExpression(node.expression);
        break;
      case 'ReturnStatement':
        if (node.argument) {
          yield* iterExpression(node.argument);
        }
        break;
      default:
        console.warn('unimplemented statement', node);
        break;
    }
  }

  function* iterExpression(node: Expression): Iterable<string> {
    switch (node.type) {
      case 'AssignmentExpression':
        yield* iterExpression(node.right);
        break;
      case 'BinaryExpression':
        yield* iterExpression(node.left);
        yield* iterExpression(node.right);
        break;
      case 'CallExpression':
        if (node.callee.type !== 'Super') {
          yield* iterExpression(node.callee);
        }
        for (const arg of node.arguments) {
          if (arg.type !== 'SpreadElement') {
            yield* iterExpression(arg);
          }
        }
        break;
      case 'MemberExpression':
        if (node.object.type === 'Identifier' && node.object.name === 'p5'
          && node.property.type === 'Identifier') {
          yield node.property.name;
        }
        break;
      case 'Identifier':
      case 'Literal':
        break;
      default:
        console.warn('unimplemented expression', node);
        break;
    }
  }
}