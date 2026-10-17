import { describe, expect, it } from "vitest";
import { isEditorCompatibleHtml, sanitizeEmailHtml, sanitizeStyle } from "./sanitize-html";

const clean = sanitizeEmailHtml;

describe("sanitizeEmailHtml: what stays", () => {
  it("keeps text formatting, lists, headings, and merge fields", () => {
    const html =
      "<h2>Hi {{first_name}}</h2><p>Your <strong>schedule</strong> and <em>desk</em> {{desk}}.</p><ul><li>One</li></ul><ol><li>Two</li></ol><blockquote>Quote</blockquote><hr><p>a<br>b</p>";
    expect(clean(html)).toBe(html);
  });

  it("keeps the schedule link merge field as a link target and adds safe link attributes", () => {
    expect(clean('<p><a href="{{schedule_link}}">Open</a></p>')).toBe(
      '<p><a href="{{schedule_link}}" target="_blank" rel="noopener noreferrer">Open</a></p>',
    );
    expect(clean('<a href="{{ schedule_link }}">Open</a>')).toContain('href="{{ schedule_link }}"');
  });

  it("keeps https and mailto links", () => {
    expect(clean('<a href="https://da.example.com/x?a=1&b=2">x</a>')).toContain('href="https://da.example.com/x?a=1&amp;b=2"');
    expect(clean('<a href="mailto:team@da.example.com">mail</a>')).toContain('href="mailto:team@da.example.com"');
  });

  it("keeps a designed table layout with legacy attributes", () => {
    const html =
      '<table width="600" align="center" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff"><thead><tr><th align="left" valign="top" width="50%">H</th></tr></thead><tbody><tr><td colspan="2" bgcolor="#eee" style="padding: 12px; color: #333333">Cell</td></tr></tbody></table>';
    expect(clean(html)).toBe(html);
  });

  it("keeps https images with alt, width, and height", () => {
    expect(clean('<img src="https://cdn.example.com/logo.png" alt="Logo" width="120" height="40">')).toBe(
      '<img src="https://cdn.example.com/logo.png" alt="Logo" width="120" height="40">',
    );
  });

  it("escapes text and attribute values it writes", () => {
    expect(clean("<p>1 < 2 & 3 > 2</p>")).toBe("<p>1 &lt; 2 &amp; 3 &gt; 2</p>");
    expect(clean('<img src="https://x.example.com/a.png" alt="a &quot;quote&quot; &lt;b&gt;">')).toBe(
      '<img src="https://x.example.com/a.png" alt="a &quot;quote&quot; &lt;b&gt;">',
    );
  });

  it("reads a pasted full document and keeps the body content", () => {
    const doc =
      '<!DOCTYPE html><html><head><title>t</title><style>p{color:red}</style><meta charset="utf-8"></head><body style="margin:0"><p>Hello</p></body></html>';
    expect(clean(doc)).toBe("<p>Hello</p>");
  });

  it("is idempotent", () => {
    const inputs = [
      '<p onclick="x">a <a href="https://x.example.com">b</a></p>',
      '<table width="100%"><tr><td style="color:red;background:url(x)">x</td></tr></table>',
      '<div style="font-family: \'Helvetica Neue\', Arial; padding: 4px 8px">{{first_name}}</div>',
      "<p>1 < 2 &amp; &lt;script&gt;</p>",
    ];
    for (const input of inputs) {
      const once = clean(input);
      expect(clean(once)).toBe(once);
    }
  });
});

describe("sanitizeEmailHtml: what goes", () => {
  it.each([
    ["script", "<p>a</p><script>alert(1)</script>", "<p>a</p>"],
    ["script with type", '<script type="text/javascript">alert(1)</script><p>a</p>', "<p>a</p>"],
    ["style block", "<style>body{display:none}</style><p>a</p>", "<p>a</p>"],
    ["iframe", '<iframe src="https://evil.example.com"></iframe><p>a</p>', "<p>a</p>"],
    ["iframe srcdoc", '<iframe srcdoc="<script>alert(1)</script>"></iframe>', ""],
    ["object", '<object data="x.swf"><param name="a" value="b"></object><p>a</p>', "<p>a</p>"],
    ["embed", '<embed src="x.swf"><p>a</p>', "<p>a</p>"],
    ["form", '<form action="https://evil.example.com"><input name="a"><button>Go</button></form><p>a</p>', "<p>a</p>"],
    ["base", '<base href="https://evil.example.com/"><p>a</p>', "<p>a</p>"],
    ["meta refresh", '<meta http-equiv="refresh" content="0;url=https://evil.example.com"><p>a</p>', "<p>a</p>"],
    ["link", '<link rel="stylesheet" href="https://evil.example.com/a.css"><p>a</p>', "<p>a</p>"],
    ["svg with script", "<svg><script>alert(1)</script></svg><p>a</p>", "<p>a</p>"],
    ["svg onload", '<svg onload="alert(1)"><circle/></svg>', ""],
    ["math", '<math><mi xlink:href="javascript:alert(1)">x</mi></math><p>a</p>', "<p>a</p>"],
    ["textarea", "<textarea><script>alert(1)</script></textarea>", ""],
    ["noscript", "<noscript><p>x</p></noscript><p>a</p>", "<p>a</p>"],
    ["template", "<template><script>alert(1)</script></template>", ""],
    ["video", '<video src="https://x.example.com/a.mp4" onerror="alert(1)"></video>', ""],
    ["comment", "<p>a</p><!-- <script>alert(1)</script> -->", "<p>a</p>"],
    ["conditional comment", "<!--[if mso]><table><tr><td><![endif]--><p>a</p>", "<p>a</p>"],
  ])("removes %s", (_name, input, expected) => {
    expect(clean(input)).toBe(expected);
  });

  it("removes event handlers and unknown attributes everywhere", () => {
    expect(clean('<p onclick="alert(1)" onmouseover="x" class="c" id="i" data-x="1" contenteditable>a</p>')).toBe("<p>a</p>");
    expect(clean('<img src="https://x.example.com/a.png" onerror="alert(1)" onload="x">')).toBe('<img src="https://x.example.com/a.png">');
    expect(clean('<a href="https://x.example.com" onclick="alert(1)">a</a>')).not.toContain("onclick");
    expect(clean('<td onclick="x" background="https://x.example.com/bg.png">a</td>')).not.toContain("background=");
  });

  it("keeps the text of unknown tags and drops the tag", () => {
    expect(clean("<custom-tag>hello <marquee>there</marquee></custom-tag>")).toBe("hello there");
  });

  it("rewrites section-like tags as div", () => {
    expect(clean("<section><p>a</p></section>")).toBe("<div><p>a</p></div>");
  });
});

describe("sanitizeEmailHtml: URLs", () => {
  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "&#106;avascript:alert(1)",
    "&#x6A;avascript:alert(1)",
    "jav&#x09;ascript:alert(1)",
    "\u0001javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "http://example.com/",
    "ftp://example.com/",
    "//example.com/",
    "/relative",
    "example.com",
    "https:example.com",
    "https://",
    "{{first_name}}",
    "{{schedule_link}}x",
    "https://exa mple.com",
    "file:///etc/passwd",
  ])("drops the link address %j but keeps the text", (href) => {
    const out = clean(`<p><a href="${href}">text</a></p>`);
    expect(out).toBe("<p>text</p>");
  });

  it("drops an image whose source is not https", () => {
    for (const src of [
      "http://x.example.com/a.png",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "//x.example.com/a.png",
      "a.png",
      "{{schedule_link}}",
      "blob:https://x.example.com/1",
    ]) {
      expect(clean(`<p>a<img src="${src}" alt="x"></p>`)).toBe("<p>a</p>");
    }
    expect(clean('<img alt="no source">')).toBe("");
  });

  it("never lets a merge field into an image source, so a private link cannot leak to a tracker", () => {
    for (const src of [
      "https://tracker.example/p.gif?u={{schedule_link}}",
      "https://{{schedule_link}}/p.gif",
      "https://tracker.example/{{first_name}}.gif",
      "{{schedule_link}}",
    ]) {
      expect(clean(`<p>a<img src="${src}" alt="x"></p>`)).toBe("<p>a</p>");
    }
  });

  it("keeps schedule_link only as the whole href of a link", () => {
    expect(clean('<a href=" {{schedule_link}} ">Open</a>')).toContain('href="{{schedule_link}}"');
    for (const href of [
      "https://tracker.example/r?u={{schedule_link}}",
      "https://tracker.example/{{ schedule_link }}",
      "mailto:a@example.com?body={{schedule_link}}",
      "https://tracker.example/?n={{first_name}}",
      "{{first_name}}",
      "{{schedule_link}}{{first_name}}",
    ]) {
      expect(clean(`<p><a href="${href}">text</a></p>`)).toBe("<p>text</p>");
    }
  });

  it("does not let srcset, lowsrc, dynsrc, or background through", () => {
    const out = clean('<img src="https://x.example.com/a.png" srcset="http://evil.example.com/b.png 2x" lowsrc="http://e" dynsrc="javascript:x" background="http://e">');
    expect(out).toBe('<img src="https://x.example.com/a.png">');
  });
});

describe("sanitizeEmailHtml: parser tricks", () => {
  it.each([
    ["broken tag split", "<scr<script>ipt>alert(1)</scr</script>ipt>"],
    ["nested script", "<scrip<script>t>alert(1)</script>"],
    ["img onerror", '<img src=x onerror=alert(1)>'],
    ["unclosed attribute", '<a href="https://x.example.com" onclick="alert(1)>x</a>'],
    ["slash separator", '<img/src="https://x.example.com/a.png"/onerror=alert(1)>'],
    ["null bytes", "<scr\u0000ipt>alert(1)</script>"],
    ["uppercase", "<SCRIPT>alert(1)</SCRIPT><IMG SRC=\"JAVASCRIPT:alert(1)\">"],
    ["entity encoded handler", '<p onclick="&#97;lert(1)">x</p>'],
    ["mXSS style in svg", "<svg><style><img src=x onerror=alert(1)></style></svg>"],
    ["mXSS noscript", '<noscript><p title="</noscript><img src=x onerror=alert(1)>">'],
    ["mXSS math", "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>"],
    ["xmp", "<xmp><img src=x onerror=alert(1)></xmp>"],
    ["plaintext", "<plaintext><img src=x onerror=alert(1)>"],
    ["comment breakout", "<!--><img src=x onerror=alert(1)>-->"],
    ["title breakout", "<title><img src=x onerror=alert(1)></title>"],
    ["textarea breakout", "<textarea></textarea><img src=x onerror=alert(1)>"],
    ["attribute breakout", '<p title="x"><img src=x onerror=alert(1)>">'],
  ])("%s", (_name, input) => {
    const out = clean(input);
    expect(out).not.toMatch(/<script|onerror|onclick|onload|javascript:/i);
    expect(out).not.toMatch(/<img[^>]*(?<!https:\/\/x\.example\.com\/a\.png")\s+src=x/i);
    expect(clean(out)).toBe(out);
  });

  it("never writes a tag outside the allowlist", () => {
    const hostile =
      '<details open ontoggle=alert(1)><summary>x</summary></details><body onload=alert(1)><isindex action=javascript:alert(1)><keygen autofocus onfocus=alert(1)><marquee onstart=alert(1)>x</marquee><bgsound src=javascript:alert(1)><applet code=a></applet><frameset onload=alert(1)>';
    const tags = [...clean(hostile).matchAll(/<\/?([a-z0-9-]+)/gi)].map((m) => m[1]);
    expect(tags).toEqual([]);
  });

  it("survives very deep nesting without a stack overflow", () => {
    const deep = "<div>".repeat(20_000) + "x" + "</div>".repeat(20_000);
    expect(() => clean(deep)).not.toThrow();
  });

  it("handles empty and whitespace input", () => {
    expect(clean("")).toBe("");
    expect(clean("   ")).toBe("   ");
  });
});

describe("sanitizeStyle", () => {
  it("keeps allowed properties and normalizes spacing", () => {
    expect(
      sanitizeStyle(
        "COLOR:#333; background-color: rgb(1, 2, 3); font-size:14px; font-weight:bold; font-style: italic; text-align:center; text-decoration:underline; line-height:1.5; width:100%; max-width:600px; height:40px; vertical-align:top; border-radius:4px",
      ),
    ).toBe(
      "color: #333; background-color: rgb(1, 2, 3); font-size: 14px; font-weight: bold; font-style: italic; text-align: center; text-decoration: underline; line-height: 1.5; width: 100%; max-width: 600px; height: 40px; vertical-align: top; border-radius: 4px",
    );
  });

  it("keeps padding, margin, and border families", () => {
    expect(sanitizeStyle("padding: 0 8px; padding-top: 2px; margin-bottom: 10px; border: 1px solid #ccc; border-bottom-color: red; border-collapse: collapse")).toBe(
      "padding: 0 8px; padding-top: 2px; margin-bottom: 10px; border: 1px solid #ccc; border-bottom-color: red; border-collapse: collapse",
    );
  });

  it("keeps quoted font families and drops a value with a semicolon inside quotes without splitting it", () => {
    expect(sanitizeStyle("font-family: 'Helvetica Neue', Arial, sans-serif")).toBe("font-family: 'Helvetica Neue', Arial, sans-serif");
    expect(sanitizeStyle('font-family: "a;b", serif; color: red')).toBe("color: red");
  });

  it("limits display to known layout values", () => {
    expect(sanitizeStyle("display:block")).toBe("display: block");
    expect(sanitizeStyle("display:inline-block")).toBe("display: inline-block");
    expect(sanitizeStyle("display:flex")).toBeNull();
    expect(sanitizeStyle("display:contents")).toBeNull();
  });

  it("drops properties that are not on the list", () => {
    expect(sanitizeStyle("position:fixed; top:0; left:0; z-index:9999; float:left; background:red; content:'x'; opacity:0; transform:scale(9); cursor:pointer; pointer-events:none; overflow:visible; visibility:hidden; color:red")).toBe(
      "color: red",
    );
    expect(sanitizeStyle("position:fixed")).toBeNull();
  });

  it.each([
    "background-color: url(https://evil.example.com/x.png)",
    "background-color: URL(javascript:alert(1))",
    "background-color: u\\rl(https://evil.example.com)",
    "width: expression(alert(1))",
    "width: EXPRESSION(alert(1))",
    "color: javascript:alert(1)",
    "behavior: url(x.htc)",
    "-moz-binding: url(x)",
    "color: red /* x */",
    "color: red; /* a */ background-color: blue /* b",
    "color: \\72 ed",
    "color: red\\;",
    "width: calc(100% - 10px)",
    "color: var(--x)",
    "background-color: image-set('x' 1x)",
    "font-family: 'unclosed",
    "color: <script>",
    "color: red}</style><script>alert(1)</script>",
    "padding: 1px; @import 'x'",
    "border: 1px solid url(x)",
  ])("drops the unsafe declaration %j", (style) => {
    const out = sanitizeStyle(style) ?? "";
    expect(out).not.toMatch(/url|expression|javascript|binding|behavior|\\|\/\*|<|>|@import|var\(|calc/i);
  });

  it("does not let a bad declaration take its neighbours with it", () => {
    expect(sanitizeStyle("color: red; background-color: url(x); padding: 4px")).toBe("color: red; padding: 4px");
  });

  it("applies to the style attribute on any allowed tag", () => {
    expect(clean('<p style="color: red; position: absolute">a</p>')).toBe('<p style="color: red">a</p>');
    expect(clean('<p style="position: absolute">a</p>')).toBe("<p>a</p>");
    expect(clean('<td style="background-color: url(javascript:alert(1))">a</td>')).toBe("<td>a</td>");
    // A quote in a value is escaped in the attribute, so it cannot end it.
    expect(clean(`<p style="font-family: 'A', serif">a</p>`)).toBe(`<p style="font-family: 'A', serif">a</p>`);
    expect(clean(`<p style='font-family: "A", serif'>a</p>`)).toBe('<p style="font-family: &quot;A&quot;, serif">a</p>');
  });
});

describe("attribute values", () => {
  it("drops malformed legacy attributes", () => {
    expect(clean('<table width="100%;x" border="1000" cellpadding="a" bgcolor="red;x" align="evil"><tr><td>x</td></tr></table>')).toBe(
      "<table><tbody><tr><td>x</td></tr></tbody></table>",
    );
    expect(clean('<td align="CENTER" valign="Top" bgcolor="#ABCDEF" width="50%">x</td>')).toBe('<td align="center" valign="top" bgcolor="#ABCDEF" width="50%">x</td>');
  });
});

describe("isEditorCompatibleHtml", () => {
  it("accepts what the editor produces", () => {
    expect(isEditorCompatibleHtml("")).toBe(true);
    expect(isEditorCompatibleHtml("<p>Hi {{first_name}},</p><p>Open it: {{schedule_link}}</p>")).toBe(true);
    expect(
      isEditorCompatibleHtml(
        '<h2>T</h2><p><strong>a</strong> <em>b</em> <u>c</u> <s>d</s><br><a href="https://x.example.com" target="_blank" rel="noopener noreferrer nofollow">e</a></p><ul><li><p>x</p></li></ul><ol start="2"><li>y</li></ol><blockquote><p>q</p></blockquote><hr><img src="https://x.example.com/a.png" alt="a">',
      ),
    ).toBe(true);
  });

  it("ignores whitespace between blocks", () => {
    expect(isEditorCompatibleHtml("<p>a</p>\n<p>b</p>\n")).toBe(true);
  });

  it("rejects markup the editor would drop", () => {
    expect(isEditorCompatibleHtml('<table><tr><td>x</td></tr></table>')).toBe(false);
    expect(isEditorCompatibleHtml('<div><p>x</p></div>')).toBe(false);
    expect(isEditorCompatibleHtml('<p style="color: red">x</p>')).toBe(false);
    expect(isEditorCompatibleHtml('<p><span>x</span></p>')).toBe(false);
    expect(isEditorCompatibleHtml('<img src="https://x.example.com/a.png" align="left">')).toBe(false);
    expect(isEditorCompatibleHtml('<p align="center">x</p>')).toBe(false);
  });
});
