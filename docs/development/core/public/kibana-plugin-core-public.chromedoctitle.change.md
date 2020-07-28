<!-- Do not edit this file. It is automatically generated by API Documenter. -->

[Home](./index.md) &gt; [kibana-plugin-core-public](./kibana-plugin-core-public.md) &gt; [ChromeDocTitle](./kibana-plugin-core-public.chromedoctitle.md) &gt; [change](./kibana-plugin-core-public.chromedoctitle.change.md)

## ChromeDocTitle.change() method

Changes the current document title.

<b>Signature:</b>

```typescript
change(newTitle: string | string[]): void;
```

## Parameters

|  Parameter | Type | Description |
|  --- | --- | --- |
|  newTitle | <code>string &#124; string[]</code> |  |

<b>Returns:</b>

`void`

## Example

How to change the title of the document

```ts
chrome.docTitle.change('My application title')
chrome.docTitle.change(['My application', 'My section'])

```
