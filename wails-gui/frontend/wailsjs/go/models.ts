export namespace main {
	
	export class ReasonEntry {
	    t: string;
	    title: string;
	    kw: string;
	    content: string;
	
	    static createFrom(source: any = {}) {
	        return new ReasonEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.t = source["t"];
	        this.title = source["title"];
	        this.kw = source["kw"];
	        this.content = source["content"];
	    }
	}

}

