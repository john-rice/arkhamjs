/**
 * Copyright (c) 2018, Nitrogen Labs, Inc.
 * Copyrights licensed under the MIT License. See the accompanying LICENSE file for terms.
 */

import {EventEmitter} from 'events';
import {cloneDeep, debounce, get, merge, set} from 'lodash';
import {ArkhamConstants} from '../constants/ArkhamConstants';
import {Store} from '../Store/Store';

export type FluxPluginMethodType = (action: FluxAction, store: object) => Promise<FluxAction>;

export interface FluxOptions {
  readonly basename?: string;
  readonly context?: object;
  readonly getUserConfirmation?: () => void;
  readonly hashType?: 'slash' | 'noslash' | 'hashbang';
  readonly history?: object;
  readonly initialEntries?: any[];
  readonly initialIndex?: number;
  readonly keyLength?: number;
  readonly location?: string | object;
  readonly name?: string;
  readonly routerType?: string;
  readonly scrollToTop?: boolean;
  readonly storage?: FluxStorageType;
  readonly stores?: any[];
  readonly title?: string;
}

export interface FluxAction {
  readonly type: string;
  readonly [key: string]: any;
}

export interface FluxStorageType {
  readonly getStorageData: (key: string) => Promise<any>;
  readonly setStorageData: (key: string, value: any) => Promise<boolean>;
}

export interface FluxMiddlewareType {
  readonly name: string;
  readonly preDispatch?: FluxPluginMethodType;
  readonly postDispatch?: FluxPluginMethodType;
}

export interface FluxPluginType {
  readonly name: string;
  readonly method: FluxPluginMethodType;
}

/**
 * FluxFramework
 * @type {EventEmitter}
 */
export class FluxFramework extends EventEmitter {
  // Public properties
  pluginTypes: string[] = ['preDispatch', 'postDispatch'];

  // Private properties
  private store: any = {};
  private storeClasses: any = {};
  private defaultOptions: FluxOptions = {
    name: 'arkhamjs',
    routerType: 'browser',
    scrollToTop: true,
    storage: null,
    stores: [],
    title: 'ArkhamJS'
  };
  private middleware: any = {};
  private options: FluxOptions = this.defaultOptions;
  private updateStorage;

  /**
   * Create a new instance of Flux.  Note that the Flux object
   * is a Singleton pattern, so only one should ever exist.
   *
   * @constructor
   * @this {FluxFramework}
   */
  constructor() {
    super();

    // Methods
    this.addMiddleware = this.addMiddleware.bind(this);
    this.clearAppData = this.clearAppData.bind(this);
    this.clearMiddleware = this.clearMiddleware.bind(this);
    this.deregister = this.deregister.bind(this);
    this.deregisterStores = this.deregisterStores.bind(this);
    this.dispatch = this.dispatch.bind(this);
    this.getClass = this.getClass.bind(this);
    this.getOptions = this.getOptions.bind(this);
    this.getStore = this.getStore.bind(this);
    this.init = this.init.bind(this);
    this.off = this.off.bind(this);
    this.register = this.register.bind(this);
    this.registerStores = this.registerStores.bind(this);
    this.removeMiddleware = this.removeMiddleware.bind(this);
    this.setStore = this.setStore.bind(this);

    // Add middleware plugin types
    this.pluginTypes.forEach((type: string) => this.middleware[`${type}List`] = []);
  }

  /**
   * Add middleware to framework.
   *
   * @param {array} middleware An array of middleware to add to the framework.
   */
  addMiddleware(middleware: FluxMiddlewareType[]): void {
    middleware.forEach((middleObj: FluxMiddlewareType) => {
      // Make sure middleware is either a class or object.
      if(!!middleObj && ((typeof middleObj === 'function') || (typeof middleObj === 'object'))) {
        const middleName: string = middleObj.name || '';

        if(!middleName) {
          throw Error('Unknown middleware is not configured properly. Requires name property. Cannot add to Flux.');
        }

        // Sort middleware plugins for efficiency
        this.pluginTypes.forEach((type: string) => {
          const method = middleObj[type];
          const plugin: FluxPluginType = {method, name: middleName};
          this.middleware[`${type}List`] = this.addPlugin(type, plugin);
        });
      } else {
        throw Error('Unknown middleware is not configured properly. Cannot add to Flux.');
      }
    });
  }

  /**
   * Remove all app data from storage.
   *
   * @returns {Promise<boolean>} Whether app data was successfully removed.
   */
  clearAppData(): Promise<boolean> {
    // Set all store data to initial state
    Object
      .keys(this.storeClasses)
      .forEach((storeName: string) => {
        const storeCls: Store = this.storeClasses[storeName];
        this.store[storeCls.name] = cloneDeep(storeCls.initialState());
      });

    const {name, storage} = this.options;
    return storage.setStorageData(name, this.store);
  }

  /**
   * Remove all middleware.
   *
   * @returns {boolean} Whether middleware was successfully removed.
   */
  clearMiddleware(): boolean {
    // Set all store data to initial state
    Object
      .keys(this.middleware)
      .forEach((pluginType: string) => {
        this.middleware[pluginType] = [];
      });

    return true;
  }

  /**
   * De-registers named stores.
   *
   * @param {array} storeNames An array of store names to remove from the framework.
   */
  deregisterStores(storeNames: string[]): void {
    storeNames.forEach((name: string) => this.deregister(name));
  }

  /**
   * Dispatches an action to all stores.
   *
   * @param {object} action to dispatch to all the stores.
   * @param {boolean} silent To silence any events.
   * @returns {Promise} The promise is resolved when and if the app saves data to storage, returning
   * the action.
   */
  async dispatch(action: FluxAction, silent: boolean = false): Promise<FluxAction> {
    let clonedAction: FluxAction = cloneDeep(action);

    // Apply middleware before the action is processed
    const {postDispatchList = [], preDispatchList = []} = this.middleware;

    if(preDispatchList.length) {
      clonedAction = await Promise
        .all(preDispatchList.map(async (plugin: FluxPluginType) => {
          return plugin.method(cloneDeep(clonedAction), cloneDeep(this.store));
        }))
        .then((actions) => merge(cloneDeep(clonedAction), ...cloneDeep(actions)) as FluxAction);
    }

    const {type, ...data} = clonedAction;

    // Require a type
    if(!type) {
      return Promise.resolve(clonedAction);
    }

    // When an action comes in, it must be completely handled by all stores
    Object
      .keys(this.storeClasses)
      .forEach((storeName: string) => {
        const storeCls: Store = this.storeClasses[storeName];
        const state = cloneDeep(this.store[storeName]) || cloneDeep(storeCls.initialState()) || {};
        this.store[storeName] = cloneDeep(storeCls.onAction(type, data, state)) || state;
      });

    // Save cache in storage
    const {storage} = this.options;

    if(storage) {
      await this.updateStorage();
    }

    if(postDispatchList.length) {
      clonedAction = await Promise
        .all(postDispatchList.map(async (plugin: FluxPluginType) => {
          return plugin.method(cloneDeep(clonedAction), cloneDeep(this.store));
        }))
        .then((actions) => merge(cloneDeep(clonedAction), ...cloneDeep(actions)) as FluxAction);
    }

    if(!silent) {
      this.emit(type, clonedAction);
    }

    return Promise.resolve(clonedAction);
  }

  /**
   * Get a store object that is registered with Flux.
   *
   * @param {string} name The name of the store.
   * @returns {Store} the store object.
   */
  getClass(name: string = ''): Store {
    return this.storeClasses[name];
  }

  /**
   * Get the current Flux options.
   *
   * @returns {FluxOptions} the Flux options object.
   */
  getOptions(): FluxOptions {
    return this.options;
  }

  /**
   * Get the current state object.
   *
   * @param {string|array} [name] (optional) The name of the store for an object, otherwise it will return all store
   *   objects. You can also use an array to specify a property path within the object.
   * @param {any} [defaultValue] (optional) A default value to return if null.
   * @returns {any} the state object or a property value within.
   */
  getStore(name: string | string[] = '', defaultValue?): any {
    let storeValue;

    if(!name) {
      storeValue = this.store || {};
    } else {
      storeValue = get(this.store, name);
    }

    const value = cloneDeep(storeValue);
    return value === undefined ? defaultValue : value;
  }

  /**
   * Initialize and set configuration options.
   *
   * @param {object} options Configuration options.
   */
  async init(options: FluxOptions): Promise<void> {
    this.options = {...this.defaultOptions, ...options};
    const {name, stores} = this.options;

    // Update default store
    await this.useStore(name);

    if(stores.length) {
      await this.registerStores(stores);
    }

    this.emit(ArkhamConstants.INIT);
  }

  /**
   * Adds an initialization listener.
   *
   * @param {function} [listener] The callback associated with the subscribed event.
   */
  onInit(listener: (...args: any[]) => void): void {
    this.on(ArkhamConstants.INIT, listener);
  }

  /**
   * Removes the initialization listener.
   *
   * @param {function} [listener] The callback associated with the subscribed event.
   */
  offInit(listener: (...args: any[]) => void): void {
    this.off(ArkhamConstants.INIT, listener);
  }

  /**
   * Removes an event listener.
   *
   * @param {string} [eventType] Event to unsubscribe.
   * @param {function} [listener] The callback associated with the subscribed event.
   */
  off(eventType: string, listener: (...args: any[]) => void): this {
    return this.removeListener(eventType, listener);
  }

  /**
   * Adds an event listener.
   *
   * @param {string} [eventType] Event to subscribe.
   * @param {function} [listener] The callback associated with the subscribed event.
   */
  on(eventType: string, listener: (...args: any[]) => void): this {
    return this.addListener(eventType, listener);
  }

  /**
   * Registers new Stores.
   *
   * @param {array} stores Store class.
   * @returns {Promise<object[]>} the class object(s).
   */
  async registerStores(stores: any[]): Promise<object[]> {
    const storeClasses: Store[] = stores.map((store: Store) => this.register(store));
    // Save cache in session storage
    const {name, storage} = this.options;

    if(storage) {
      await storage.setStorageData(name, this.store);
    }

    // Emit ready event
    this.emit(ArkhamConstants.INIT);

    // Return classes
    return storeClasses;
  }

  /**
   * Remove middleware from framework.
   *
   * @param {array} string middleware names to remove.
   * @returns {Promise<object[]>} the class object(s).
   */
  removeMiddleware(names: string[]): void {
    names.forEach((name: string) => {
      // Remove middleware plugins
      this.pluginTypes.forEach((type: string) => {
        this.middleware[`${type}List`] = this.removePlugin(type, name);
      });
    });
  }

  /**
   * Sets the current state object.
   *
   * @param {string|array} [name] The name of the store to set. You can also use an array to specify a property path
   * within the object.
   * @param {any} [value] The value to set.
   */
  setStore(name: string | string[] = '', value): void {
    if(!!name) {
      this.store = set(this.store, name, cloneDeep(value));
    }
  }

  private addPlugin(type: string, plugin: FluxPluginType): FluxPluginType[] {
    const list = this.middleware[`${type}List`] || [];
    const {method, name} = plugin;

    if(method && typeof method === 'function') {
      // Check if plugin already exists
      const exists: boolean = !!list.filter((obj: FluxPluginType) => obj.name === name).length;

      // Do not add duplicate plugins
      if(!exists) {
        list.push({name, method});
      }

      return list;
    } else if(method !== undefined) {
      throw Error(`${plugin.name} middleware is not configured properly. Method is not a function.`);
    }

    return list;
  }

  private deregister(name: string = ''): void {
    delete this.storeClasses[name];
    delete this.store[name];
  }

  private register(StoreClass): Store {
    if(!StoreClass) {
      throw Error('Class is undefined. Cannot register with Flux.');
    }

    const clsType: string = StoreClass.constructor.toString().substr(0, 5);

    if(clsType !== 'class' && clsType !== 'funct') {
      throw Error(`${StoreClass} is not a class. Cannot register with Flux.`);
    }

    // Create store object
    const storeCls = new StoreClass();
    const {name: storeName} = storeCls;

    if(storeName && !this.storeClasses[storeName]) {
      // Save store object
      this.storeClasses[storeName] = storeCls;

      // Get default values
      this.store[storeName] = this.store[storeName] || cloneDeep(storeCls.initialState()) || {};
    }

    // Return store class
    return this.storeClasses[storeName];
  }

  private removePlugin(type: string, name: string): FluxPluginType[] {
    const list = this.middleware[`${type}List`] || [];

    // remove all occurrences of the plugin
    return list.filter((obj: FluxPluginType) => obj.name !== name);
  }

  private async useStore(name: string): Promise<void> {
    const {storage} = this.options;

    // Cache
    if(storage) {
      this.store = await storage.getStorageData(name) || {};
      this.updateStorage = debounce(() => {
        return storage.setStorageData(name, this.store);
      }, 300, {leading: true, trailing: true});
    }

    return null;
  }
}

export const Flux: FluxFramework = new FluxFramework();
