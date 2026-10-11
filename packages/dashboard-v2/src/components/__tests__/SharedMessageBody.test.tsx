import {describe,it,expect} from 'vitest';
import {render,screen,cleanup,fireEvent} from '@testing-library/react';
import {afterEach} from 'vitest';
import {SharedMessageBody,readableAgentText,presentationText} from '../chat/SharedMessageBody';
afterEach(cleanup);
describe('SharedMessageBody',()=>{
 it('separates findings and retains citation text',()=>{expect(readableAgentText('<agent_finding type="insight">First <cite tag="file">/repo/a.ts:12</cite></agent_finding><agent_finding type="warning">Second</agent_finding>')).toBe('First `/repo/a.ts:12`\n\nSecond');});
 it('preserves protocol examples inside fenced code',()=>{const code='```xml\n<agent_finding>example</agent_finding>\n```';expect(readableAgentText(code)).toBe(code);});
 it('keeps original available and escapes untrusted HTML',()=>{const text='<agent_finding><img src=x onerror="alert(1)">Finding</agent_finding>';const {container}=render(<SharedMessageBody text={text} agent/>);expect(screen.getByText('Ham mesajı göster')).toBeTruthy();expect(container.querySelector('img')).toBeNull();expect(container.querySelector('pre')?.textContent).toBe(text);});
 it('moves long file references into numbered sources',()=>{const {prose,sources}=presentationText('Result `/Users/me/Desktop/gossip/src/a.ts:12` and `/Users/me/Desktop/gossip/src/a.ts:12`');expect(prose).not.toContain('/Users');expect(sources).toEqual(['/Users/me/Desktop/gossip/src/a.ts:12']);expect(prose.match(/\[1\]/g)).toHaveLength(2);});
 it('renders highlighted code without changing code contents or creating HTML elements',()=>{const {container}=render(<SharedMessageBody agent text={'```typescript\nconst answer = "<img src=x>";\n```'}/>);expect(container.querySelector('.hljs-keyword')?.textContent).toBe('const');expect(container.querySelector('pre code')?.textContent).toContain('<img src=x>');expect(container.querySelector('img')).toBeNull();});
 it('leaves user prompts unchanged',()=>{render(<SharedMessageBody text='<agent_finding>example</agent_finding>' agent={false}/>);expect(screen.queryByText('Ham mesajı göster')).toBeNull();});
 it('offers code copy and expands long blocks',()=>{render(<SharedMessageBody agent text={'```ts\n'+Array(12).fill('const n = 1;').join('\n')+'\n```'}/>);expect(screen.getByText('Kodu kopyala')).toBeTruthy();fireEvent.click(screen.getByText('Kodun tamamını göster'));expect(screen.getByText('Daralt')).toBeTruthy();});
});
