import createDispatcher, { FormKitDispatcher } from './dispatcher'
import { FormKitSearchFunction, bfs, dedupe, has, isNode, names } from './utils'

/**
 * The base interface definition for a FormKitPlugin — it's just a function that
 * accepts a node argument.
 */
export interface FormKitPlugin<T = any> {
  (node: FormKitNode<T>): void | boolean
}

/**
 * The available hooks for middleware.
 */
export interface FormKitHooks<ValueType> {
  init: FormKitDispatcher<FormKitNode<ValueType>>
  commit: FormKitDispatcher<ValueType>
  input: FormKitDispatcher<ValueType>
}

/**
 * The definition of a FormKitTrap — these are somewhat like methods on each
 * FormKitNode — they are always symmetrical (get/set), although it's acceptable
 * for either to throw an Exception.
 */
export interface FormKitTrap<T> {
  get: TrapGetter<T>
  set: TrapSetter<T>
}

/**
 * Describes the path to a particular node from the top of the tree.
 */
type FormKitAddress = Array<string | number>

/**
 * Determines if the 'value' property of an object has been set.
 */
type HasValue = { value: unknown }

/**
 * Determines if the 'type' property of an object exists.
 */
type HasType = { type: FormKitNodeType }

/**
 * Extracts the node type
 */
type ExtractType<T> = T extends HasType ? T['type'] : 'input'

/**
 * Extracts the type of the value from the node
 */
type ExtractValue<T> = T extends HasValue ? T['value'] : void

/**
 * These are the type of nodes that can be created — these are different from
 * the type of inputs available and rather describe their purpose in the tree.
 */
export type FormKitNodeType = 'input' | 'list' | 'group'

/**
 * FormKit inputs of type 'group' must have keyed values by default.
 */
export interface FormKitGroupValue {
  [index: string]: unknown
}

/**
 * FormKit inputs of type 'list' must have array values by default.
 */
export type FormKitListValue<T = any> = Array<T>

/**
 * Given a FormKitNodeType determine what the proper value of the input is.
 */
export type ExtractValueType<T extends FormKitNodeType> = T extends 'group'
  ? FormKitGroupValue
  : T extends 'list'
  ? FormKitListValue
  : void

/**
 * Type utility for determining the type of the value property.
 */
type TypeOfValue<T> = ExtractValueType<ExtractType<T>> extends void
  ? T extends HasValue // In this case we dont have a `type` option, so infer from the value object
    ? T['value']
    : any
  : ExtractValue<T> extends ExtractValueType<ExtractType<T>>
  ? ExtractValue<T>
  : ExtractValueType<ExtractType<T>>

/**
 * Arbitrary data that has properties, could be a pojo, could be an array.
 */
export interface KeyedValue {
  [index: number]: any
  [index: string]: any
}

/**
 * Signature for any of the node's getter traps. Keep in mind that because these
 * are traps and not class methods, their response types are declared explicitly
 * in the FormKitNode interface.
 */
type TrapGetter<T> =
  | ((
      node: FormKitNode<T>,
      context: FormKitContext<T>,
      ...args: any[]
    ) => unknown)
  | false

/**
 * The signature for a node's trap setter — these are more rare than getter
 * traps, but can be really useful for blocking access to certain context
 * properties or modifying the behavior of an assignment (ex. see setParent)
 */
type TrapSetter<T> =
  | ((
      node: FormKitNode<T>,
      context: FormKitContext<T>,
      property: string | symbol,
      value: any
    ) => boolean | never)
  | false

/**
 * The map signature for a node's traps Map.
 */
export type FormKitTraps<T> = Map<string | symbol, FormKitTrap<T>>

/**
 * General "app" like configuration options, these are automatically inherited
 * by all children — they are not reactive.
 */
export interface FormKitConfig {
  delimiter: string
  [index: string]: any
}

/**
 * The interface of the a FormKit node's context object. A FormKit node is a
 * proxy of this object.
 */
export interface FormKitContext<ValueType = any> {
  children: Array<FormKitNode<any>>
  config: FormKitConfig
  hook: FormKitHooks<ValueType>
  name: string | symbol
  parent: FormKitNode<any> | null
  plugins: Set<FormKitPlugin>
  traps: FormKitTraps<ValueType>
  type: FormKitNodeType
  value: ValueType
}

/**
 * Options that can be used to instantiate a new node via createNode()
 */
export type FormKitOptions = Partial<
  Omit<FormKitContext, 'children' | 'plugins' | 'config' | 'hook'> & {
    config: Partial<FormKitConfig>
    children: FormKitNode<any>[] | Set<FormKitNode<any>>
    plugins: FormKitPlugin[] | Set<FormKitPlugin>
  }
>

/**
 * The callback type for node.each()
 */
export interface FormKitChildCallback {
  (child: FormKitNode): void
}

/**
 * FormKit's Node object produced by createNode(). All inputs, forms, and groups
 * are instances of nodes.
 */
export type FormKitNode<T = void> = {
  readonly __FKNode__: true
  readonly value: T extends void ? any : T
  add: (node: FormKitNode<any>) => FormKitNode<T>
  at: (address: FormKitAddress | string) => FormKitNode<any> | undefined
  address: FormKitAddress
  config: FormKitConfig
  each: (callback: FormKitChildCallback) => void
  find: (
    selector: string,
    searcher?: keyof FormKitNode | FormKitSearchFunction<T>
  ) => FormKitNode | undefined
  index: number
  input: (value: T) => FormKitNode<T>
  name: string
  remove: (node: FormKitNode<any>) => FormKitNode<T>
  root: FormKitNode<any>
  setConfig: (config: FormKitConfig) => void
  use: (
    plugin: FormKitPlugin | FormKitPlugin[] | Set<FormKitPlugin>
  ) => FormKitNode<T>
  walk: (callback: FormKitChildCallback) => void
} & Omit<FormKitContext, 'value' | 'name' | 'config'>

/**
 * If a node’s name is set to useIndex, it replaces the node’s name with the
 * index of the node relative to its parent’s children.
 */
export const useIndex = Symbol('index')

/**
 * The setter you are trying to access is invalid.
 */
const invalidSetter = (): never => {
  // @todo add log event and error
  throw new Error()
}

/**
 * These are all the available "traps" for a given node. You can think of these
 * a little bit like methods, but they are really Proxy interceptors rather
 * than actual methods.
 */
function createTraps<T>(): FormKitTraps<T> {
  return new Map<string | symbol, FormKitTrap<T>>(
    Object.entries({
      add: trap<T>(addChild),
      address: trap<T>(getAddress, invalidSetter, false),
      at: trap<any>(getNode),
      config: trap<T>(false, invalidSetter),
      index: trap<T>(getIndex, setIndex, false),
      input: trap<T>(input),
      each: trap<T>(eachChild),
      find: trap<T>(find),
      parent: trap<T>(false, setParent),
      plugins: trap<T>(false, invalidSetter),
      remove: trap<T>(removeChild),
      root: trap<T>(getRoot, invalidSetter, false),
      setConfig: trap<T>(setConfig),
      use: trap<T>(use),
      name: trap<T>(getName, false, false),
      walk: trap<T>(walkTree),
    })
  )
}

/**
 * Creates a getter/setter trap and curries the context/node pair.
 * @param  {TrapGetter} getter
 * @param  {TrapSetter} setter?
 * @returns FormKitTrap
 */
function trap<T>(
  getter?: TrapGetter<T>,
  setter?: TrapSetter<T>,
  curryGetter: boolean = true
): FormKitTrap<T> {
  return {
    get: getter
      ? (node, context) =>
          curryGetter
            ? (...args: any[]) => getter(node, context, ...args)
            : getter(node, context)
      : false,
    set: setter !== undefined ? setter : invalidSetter,
  }
}

/**
 * Create a new context object for our a FormKit node, given default information
 * @param  {T} options
 * @returns FormKitContext
 */
function createContext<T extends FormKitOptions>(
  options: T
): FormKitContext<TypeOfValue<T>> {
  const type: FormKitNodeType = options.type || 'input'
  return {
    children: dedupe(options.children || []),
    config: createConfig(options.parent, options.config),
    name: createName(options, type),
    hook: {
      init: createDispatcher<FormKitNode<TypeOfValue<T>>>(),
      input: createDispatcher<TypeOfValue<T>>(),
      commit: createDispatcher<TypeOfValue<T>>(),
    },
    parent: options.parent || null,
    plugins: new Set<FormKitPlugin>(),
    traps: createTraps<TypeOfValue<T>>(),
    type,
    value: createValue(options),
  }
}

/**
 * This is a simple integer counter of every create(), it is used to
 * deterministically name new nodes.
 */
let nodeCount = 0
export function resetCount(): void {
  nodeCount = 0
}

/**
 * This node is responsible for deterministically generating an id for this
 * node. This cannot just be a random id, it _must_ be deterministic to ensure
 * re-hydration of the form (like post-SSR) produces the same names/ids.
 *
 * @param  {FormKitOptions} options
 * @returns string
 */
function createName(
  options: FormKitOptions,
  type: FormKitNodeType
): string | symbol {
  if (options.parent?.type === 'list') return useIndex
  return options.name || `${type}_${++nodeCount}`
}

/**
 * Creates the initial value for a node based on the options passed in and the
 * type of the input.
 * @param  {FormKitOptions} options
 * @param  {T} type
 * @returns Textends
 */
function createValue<T extends FormKitOptions>(options: T): TypeOfValue<T> {
  if (options.type === 'group') {
    return options.value &&
      options.value === 'object' &&
      !Array.isArray(options.value)
      ? options.value
      : {}
  } else if (options.type === 'list') {
    return (Array.isArray(options.value) ? options.value : []) as TypeOfValue<T>
  }
  return options.value === null ? '' : options.value
}

/**
 * Sets the internal value of the node.
 * @param  {T} node
 * @param  {FormKitContext} context
 * @param  {TextendsFormKitNode<inferX>?X:never} value
 * @returns T
 */
function input<T>(
  node: FormKitNode<T>,
  context: FormKitContext,
  value: T
): FormKitNode<T> {
  const preCommit: T = node.hook.input.dispatch(value)
  if (!node.children.length) {
    context.value = preCommit
    // @todo emit('commit')
  } else if (preCommit && typeof preCommit === 'object') {
    const children = names(node.children)
    for (const name in children) {
      if (has(preCommit, name))
        children[name].input((preCommit as KeyedValue)[name])
    }
  }
  return node
}

/**
 * (node.add) Adds a child to the node.
 * @param  {FormKitContext} context
 * @param  {FormKitNode} node
 * @param  {FormKitNode} child
 */
function addChild<T>(
  parent: FormKitNode<T>,
  parentContext: FormKitContext,
  child: FormKitNode<any>
) {
  if (child.parent && child.parent !== parent) {
    child.parent.remove(child)
  }
  if (!parentContext.children.includes(child)) {
    parentContext.children.push(child)
  }
  if (child.parent !== parent) {
    child.parent = parent
    // In this edge case middleware changed the parent assignment so we need to
    // re-add the child
    if (child.parent !== parent) {
      parent.remove(child)
      child.parent.add(child)
    }
  } else {
    child.use(parent.plugins)
  }
  return parent
}

/**
 * (node.remove) Removes a child from the node.
 * @param  {FormKitContext} context
 * @param  {FormKitNode} node
 * @param  {FormKitNode} child
 */
function removeChild<T>(
  node: FormKitNode<T>,
  context: FormKitContext,
  child: FormKitNode<any>
) {
  const childIndex = context.children.indexOf(child)
  if (childIndex !== -1) {
    context.children.splice(childIndex, 1)
    child.parent = null
  }
  return node
}

/**
 * Iterate over each immediate child and perform a callback.
 * @param  {FormKitContext} context
 * @param  {FormKitNode} _node
 * @param  {FormKitChildCallback} callback
 */
function eachChild<T>(
  _node: FormKitNode<T>,
  context: FormKitContext,
  callback: FormKitChildCallback
) {
  context.children.forEach((child) => callback(child))
}

/**
 * Walk all nodes below this one and execute a callback.
 * @param  {FormKitNode} _node
 * @param  {FormKitContext} context
 * @param  {FormKitChildCallback} callback
 */
function walkTree<T>(
  _node: FormKitNode<T>,
  context: FormKitContext,
  callback: FormKitChildCallback
) {
  context.children.forEach((child) => {
    callback(child)
    child.walk(callback)
  })
}
/**
 * Set the configuration options of the node and it's subtree.
 * @param  {FormKitNode} node
 * @param  {FormKitContext} context
 * @param  {string} _property
 * @param  {FormKitConfig} config
 */
function setConfig<T>(
  node: FormKitNode<T>,
  context: FormKitContext,
  config: FormKitConfig
) {
  context.config = config
  node.walk((n) => n.setConfig(config))
}

/**
 * Adds a plugin to the node, it’s children, and executes it.
 * @param  {FormKitContext} context
 * @param  {FormKitNode} node
 * @param  {FormKitPlugin} plugin
 */
export function use<T>(
  node: FormKitNode<T>,
  context: FormKitContext,
  plugin: FormKitPlugin<any> | FormKitPlugin<any>[] | Set<FormKitPlugin<any>>
) {
  if (Array.isArray(plugin) || plugin instanceof Set) {
    plugin.forEach((p: FormKitPlugin<any>) => use(node, context, p))
    return node
  }
  if (!context.plugins.has(plugin)) {
    context.plugins.add(plugin)
    if (plugin(node) !== false) {
      // If a plugin returns `false` it does not descend to children
      node.children.forEach((child) => child.use(plugin))
    }
  }
  return node
}

/**
 * Moves a node in the parent’s children to the given index.
 * @param  {FormKitNode} node
 * @param  {FormKitContext} _context
 * @param  {string|symbol} _property
 * @param  {number} setIndex
 */
function setIndex<T>(
  node: FormKitNode<T>,
  _context: FormKitContext,
  _property: string | symbol,
  setIndex: number
) {
  if (isNode(node.parent)) {
    const children = node.parent.children
    let index =
      setIndex >= children.length
        ? children.length - 1
        : setIndex < 0
        ? 0
        : setIndex
    const oldIndex = children.indexOf(node)
    if (oldIndex === -1) return false
    children.splice(oldIndex, 1)
    children.splice(index, 0, node)
    node.parent.children = children
    return true
  }
  return false
}

/**
 * Retrieves the index of a node from the parent’s children.
 * @param  {FormKitNode} node
 */
function getIndex<T>(node: FormKitNode<T>) {
  return node.parent ? [...node.parent.children].indexOf(node) : -1
}

/**
 * Get the name of the current node, allowing for slight mutations.
 * @param  {FormKitNode} node
 * @param  {FormKitContext} context
 */
function getName<T>(node: FormKitNode<T>, context: FormKitContext<T>) {
  return context.name !== useIndex ? context.name : node.index
}

/**
 * Returns the address of the current node.
 * @param  {FormKitNode} node
 * @param  {FormKitContext} context
 */
function getAddress<T>(
  node: FormKitNode<T>,
  context: FormKitContext
): FormKitAddress {
  return context.parent
    ? context.parent.address.concat([node.name])
    : [node.name]
}

/**
 * Fetches a node from the tree by its address.
 * @param  {FormKitContext} context
 * @param  {FormKitNode} node
 * @param  {string|FormKitAddress} location
 * @returns FormKitNode
 */
function getNode(
  node: FormKitNode,
  _context: FormKitContext,
  locator: string | FormKitAddress
): FormKitNode | undefined {
  const address =
    typeof locator === 'string' ? locator.split(node.config.delimiter) : locator
  if (!address.length) return undefined
  const first = address[0]
  let pointer: FormKitNode | null | undefined = node.parent
  if (!pointer) {
    // This address names the root node, remove it to get child name:
    if (String(address[0]) === String(node.name)) address.shift()
    // All root nodes start at themselves ultimately:
    pointer = node
  }
  // Any addresses starting with $parent should discard it
  if (first === '$parent') address.shift()
  while (pointer && address.length) {
    const name = address.shift() as string | number
    switch (name) {
      case '$root':
        pointer = node.root
        break
      case '$parent':
        pointer = pointer.parent
        break
      case '$self':
        pointer = node
        break
      default:
        pointer =
          pointer.children.find((c) => String(c.name) === String(name)) ||
          select(pointer, name)
    }
  }
  return pointer || undefined
}

/**
 * Perform selections on a subtree using the address "selector" methods.
 * @param  {FormKitNode} node
 * @param  {string|number} selector
 * @returns FormKitNode | undefined
 */
function select(
  node: FormKitNode,
  selector: string | number
): FormKitNode | undefined {
  const matches = String(selector).match(/^(find)\((.*)\)$/)
  if (matches) {
    const [, action, argStr] = matches
    const args = argStr.split(',').map((arg) => arg.trim())
    switch (action) {
      case 'find':
        return node.find(args[0], args[1] as keyof FormKitNode)
      default:
        return undefined
    }
  }
  return undefined
}

/**
 * Perform a breadth first search and return the first instance of a node that
 * is found in the subtree or undefined.
 * @param  {FormKitNode} node
 * @param  {string} name
 * @returns FormKitNode | undefined
 */
function find<T>(
  node: FormKitNode<T>,
  _context: FormKitContext,
  searchTerm: string,
  searcher: keyof FormKitNode | FormKitSearchFunction<T>
): FormKitNode | undefined {
  return bfs(node, searchTerm, searcher)
}

/**
 * Get the root node of the tree.
 */
function getRoot<T>(n: FormKitNode<T>) {
  let node = n
  while (node.parent) {
    node = node.parent
  }
  return node
}

/**
 * The setter for node.parent = FormKitNode
 * @param  {FormKitContext} _context
 * @param  {FormKitNode} node
 * @param  {string|symbol} _property
 * @param  {FormKitNode} parent
 * @returns boolean
 */
function setParent<T>(
  child: FormKitNode<T>,
  context: FormKitContext,
  _property: string | symbol,
  parent: FormKitNode<any>
): boolean {
  // If the middleware returns `false` then we do not perform the assignment
  if (isNode(parent)) {
    if (child.parent && child.parent !== parent) {
      child.parent.remove(child)
    }
    context.parent = parent
    child.setConfig(parent.config)
    !parent.children.includes(child)
      ? parent.add(child)
      : child.use(parent.plugins)
    return true
  }
  if (parent === null) {
    context.parent = null
    return true
  }
  return false
}

/**
 * Creates a new configuration option.
 * @param  {FormKitNode} parent?
 * @param  {Partial<FormKitConfig>} configOptions
 * @returns FormKitConfig
 */
function createConfig(
  parent?: FormKitNode | null,
  configOptions?: Partial<FormKitConfig>
): FormKitConfig {
  if (parent && !configOptions) {
    return parent.config
  }
  if (parent && configOptions) {
    return Object.assign(parent.config, configOptions)
  }
  return {
    delimiter: '.',
    ...configOptions,
  }
}

/**
 * Initialize a node object's internal properties.
 * @param  {FormKitNode} node
 * @returns FormKitNode
 */
function nodeInit<T>(
  node: FormKitNode<T>,
  options: FormKitOptions
): FormKitNode<T> {
  // Apply the parent to each child.
  node.each((child) => {
    child.parent = node
  })
  // If the node has a parent, ensure it's properly nested bi-directionally.
  if (node.parent) {
    node.parent.add(node)
  }
  // If the options has plugins, we apply
  options.plugins?.forEach((plugin: FormKitPlugin) => node.use(plugin))
  return node.hook.init.dispatch(node)
}

/**
 * Creates a new instance of a FormKit Node. Nodes are the atomic unit of
 * a FormKit graph.
 *
 * @param  {FormKitOptions={}} options
 * @returns FormKitNode
 */
export default function createNode<T extends FormKitOptions>(
  options?: T
): FormKitNode<TypeOfValue<T>> {
  const ops = options || {}
  const context = createContext(ops)
  // Note: The typing for the proxy object cannot be fully modeled, thus we are
  // force-typing to a FormKitNode. See:
  // https://github.com/microsoft/TypeScript/issues/28067
  const node = new Proxy(context, {
    get(...args) {
      const [, property] = args
      if (property === '__FKNode__') return true
      const trap = context.traps.get(property)
      if (trap && trap.get) return trap.get(node, context)
      return Reflect.get(...args)
    },
    set(...args) {
      const [, property, value] = args
      const trap = context.traps.get(property)
      if (trap && trap.set) return trap.set(node, context, property, value)
      return Reflect.set(...args)
    },
  }) as unknown as FormKitNode<TypeOfValue<T>>
  return nodeInit<TypeOfValue<T>>(node, ops)
}
