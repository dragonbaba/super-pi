// Fixed offline fixture only. Guest reports never authorize a host write.
using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
class OfflineWorker {
    static int Main(string[] args) {
        byte[] input=null, modified=null, added=null, manifest=null;
        try {
            if(args.Length!=2 || !Regex.IsMatch(args[0],@"\A[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\z")
                || !Regex.IsMatch(args[1],@"\A[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\z"))
                throw new InvalidOperationException("Fixed task/snapshot required");
            if(!String.Equals(Environment.CurrentDirectory,@"C:\SuperPiVolume\workspace",StringComparison.OrdinalIgnoreCase)
                || !String.Equals(Path.GetFullPath(typeof(OfflineWorker).Assembly.Location),@"C:\SuperPiVolume\tools\offline-worker.exe",StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Fixed isolated cwd/tool path required");
            using(var source=new FileStream("source.txt",FileMode.Open,FileAccess.Read,FileShare.Read)) {
                if(source.Length<1 || source.Length>4096) throw new InvalidOperationException("Input bound");
                input=new byte[(int)source.Length]; int offset=0;
                while(offset<input.Length) { int read=source.Read(input,offset,input.Length-offset); if(read==0) throw new EndOfStreamException(); offset+=read; }
            }
            string text=new UTF8Encoding(false,true).GetString(input);
            if(text!="alpha") throw new InvalidOperationException("Captured fixture contents changed");
            modified=Encoding.UTF8.GetBytes(text+"-guest\r\n");
            added=Encoding.UTF8.GetBytes("derived:"+text+"\r\n");
            string payload=@"C:\SuperPiVolume\payload";
            if(Directory.Exists(payload)) throw new InvalidOperationException("Payload already exists");
            Directory.CreateDirectory(payload);
            WriteNew(Path.Combine(payload,"source.txt"),modified);
            WriteNew(Path.Combine(payload,"new.txt"),added);
            manifest=Encoding.UTF8.GetBytes("{\"protocol\":\"super-pi-offline-candidates-v1\",\"taskId\":\""+args[0]
                +"\",\"snapshotId\":\""+args[1]+"\",\"candidates\":[{\"path\":\"new.txt\",\"operation\":\"add\"},"
                +"{\"path\":\"source.txt\",\"operation\":\"modify\"}],\"report\":{\"exitCode\":0}}");
            if(manifest.Length>4096) throw new InvalidOperationException("Manifest bound");
            WriteNew(@"C:\SuperPiVolume\candidates.json",manifest);
            return 0;
        } catch(Exception error) { Console.Error.WriteLine(error.GetType().Name); return 1; }
        finally {
            foreach(var bytes in new byte[][] {input,modified,added,manifest}) if(bytes!=null) Array.Clear(bytes,0,bytes.Length);
        }
    }
    static void WriteNew(string path,byte[] bytes) {
        using(var stream=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
            stream.Write(bytes,0,bytes.Length); stream.Flush(true);
        }
    }
}
