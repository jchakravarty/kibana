<!-- Do not edit this file. It is automatically generated by API Documenter. -->

[Home](./index.md) &gt; [kibana-plugin-core-public](./kibana-plugin-core-public.md) &gt; [HttpSetup](./kibana-plugin-core-public.httpsetup.md) &gt; [intercept](./kibana-plugin-core-public.httpsetup.intercept.md)

## HttpSetup.intercept() method

Adds a new [HttpInterceptor](./kibana-plugin-core-public.httpinterceptor.md) to the global HTTP client.

<b>Signature:</b>

```typescript
intercept(interceptor: HttpInterceptor): () => void;
```

## Parameters

|  Parameter | Type | Description |
|  --- | --- | --- |
|  interceptor | <code>HttpInterceptor</code> |  |

<b>Returns:</b>

`() => void`

a function for removing the attached interceptor.
