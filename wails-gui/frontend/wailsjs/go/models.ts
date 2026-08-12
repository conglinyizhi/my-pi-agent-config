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
	export class SupplementEntry {
	    id: string;
	    text: string;
	    state: string;
	    createdAt: string;
	    handedOffAt?: string;
	
	    static createFrom(source: any = {}) {
	        return new SupplementEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.text = source["text"];
	        this.state = source["state"];
	        this.createdAt = source["createdAt"];
	        this.handedOffAt = source["handedOffAt"];
	    }
	}
	export class SubagentSupplementInbox {
	    inboxId: string;
	    createdAt: string;
	    updatedAt: string;
	    entries: SupplementEntry[];
	
	    static createFrom(source: any = {}) {
	        return new SubagentSupplementInbox(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.inboxId = source["inboxId"];
	        this.createdAt = source["createdAt"];
	        this.updatedAt = source["updatedAt"];
	        this.entries = this.convertValues(source["entries"], SupplementEntry);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SubagentSupplementMutation {
	    inbox: SubagentSupplementInbox;
	    withdrawn: boolean;
	    merged: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SubagentSupplementMutation(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.inbox = this.convertValues(source["inbox"], SubagentSupplementInbox);
	        this.withdrawn = source["withdrawn"];
	        this.merged = source["merged"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

