import assert from "node:assert/strict";
import test from "node:test";
import { detailPngFixture } from "./helpers/image-acceptance-fixtures.ts";
import { loadPhoton } from "../packages/coding-agent/src/utils/photon.ts";
import { RequestImageBudget } from "../packages/coding-agent/src/core/request-image-budget.ts";
import type { ToolResultMessage } from "../packages/ai/src/types.ts";

for (const pattern of ["checker","glyph","edge","gradient"] as const) test(`request PNG fidelity comparison: ${pattern}`, async t => {
  const photon = await loadPhoton(); assert.ok(photon,"quality acceptance requires the actual decoder");
  const bytes = detailPngFixture(pattern), data = bytes.toString("base64");
  const message: ToolResultMessage = {role:"toolResult",toolCallId:"detail",toolName:"read",content:[{type:"image",data,mimeType:"image/png"}],isError:false,timestamp:0};
  const owner = new RequestImageBudget();
  try {
    for (const autoResize of [false,true]) {
      await owner.prepare([message],{},autoResize);
      const projected = owner.apply(message) as ToolResultMessage;
      assert.equal((projected.content[0] as any).data,data,"compatible defaults preserve the original byte representation for in-limit images");
    }
    await owner.prepare([message],{maxWidth:1568,maxHeight:1568,maxBytes:600*1024},true);
    const view = owner.apply(message) as ToolResultMessage, image = view.content.find(block=>block.type==="image")!;
    assert.equal(image.mimeType,"image/png");
    const source = photon.PhotonImage.new_from_byteslice(bytes), result = photon.PhotonImage.new_from_byteslice(Buffer.from(image.data,"base64"));
    try {
      const before = source.get_raw_pixels(), after = result.get_raw_pixels();
      const width = result.get_width(), height = result.get_height();
      assert.ok(width<=1568 && height<=105 && width<1920);
      assert.ok(image.data.length<=600*1024);
      assert.ok(view.content.some(block=>block.type==="text" && block.text.includes("1920") && block.text.includes("128") && block.text.includes(String(width))),"resizing must disclose original and view dimensions");
      let changed = 0, alphaPixels = 0, error = 0;
      for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
        const a=(y*width+x)*4,b=(Math.floor(y*128/height)*1920+Math.floor(x*1920/width))*4;
        let differs = false;
        for (let c=0;c<4;c++) {error+=Math.abs(after[a+c]!-before[b+c]!);if(after[a+c]!==before[b+c]) differs=true;}
        if(differs) changed++;
        if(after[a+3]!==255) alphaPixels++;
      }
      assert.ok(changed>0,"downsampling changes pixel-level evidence even with PNG encoding");
      if(pattern==="edge") assert.ok(alphaPixels>0,"transparent edges retain alpha");
      t.diagnostic(JSON.stringify({pattern,source:[1920,128],view:[width,height],encodedBytes:image.data.length,changedPixelsAgainstNearestSource:changed,meanChannelError:error/(width*height*4),alphaPixels}));
    } finally {source.free();result.free();}
    assert.equal((message.content[0] as any).data,data);
  } finally {owner.clear();}
});
