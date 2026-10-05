import { parseHTML } from 'linkedom';
/** Inert HTML parsing only. Scripts and remote resources are never executed. */
export class JSDOM {
  window: ReturnType<typeof parseHTML> & {close:()=>void};
  constructor(html:string,_options?:unknown) {
    const window = parseHTML(html);
    Object.defineProperty(window.document,'documentURI',{value:'https://source.invalid/',configurable:true});
    this.window = Object.assign(window,{close:()=>{}});
  }
}
