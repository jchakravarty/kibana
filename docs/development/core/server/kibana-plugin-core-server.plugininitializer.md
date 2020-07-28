<!-- Do not edit this file. It is automatically generated by API Documenter. -->

[Home](./index.md) &gt; [kibana-plugin-core-server](./kibana-plugin-core-server.md) &gt; [PluginInitializer](./kibana-plugin-core-server.plugininitializer.md)

## PluginInitializer type

The `plugin` export at the root of a plugin's `server` directory should conform to this interface.

<b>Signature:</b>

```typescript
export declare type PluginInitializer<TSetup, TStart, TPluginsSetup extends object = object, TPluginsStart extends object = object> = (core: PluginInitializerContext) => Plugin<TSetup, TStart, TPluginsSetup, TPluginsStart>;
```