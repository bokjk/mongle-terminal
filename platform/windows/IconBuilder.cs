using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Collections.Generic;

// The web/PWA master is also the source for Windows window, shortcut,
// and executable icons. Render each size directly, preserving alpha.
public static class IconBuilder {
  static byte[] Draw(Image source, int size) {
    using(var bitmap=new Bitmap(size,size,PixelFormat.Format32bppArgb)) {
      using(var graphics=Graphics.FromImage(bitmap))
      using(var attributes=new ImageAttributes()) {
        graphics.Clear(Color.Transparent);
        graphics.CompositingMode=CompositingMode.SourceCopy;
        graphics.CompositingQuality=CompositingQuality.HighQuality;
        graphics.InterpolationMode=InterpolationMode.HighQualityBicubic;
        graphics.PixelOffsetMode=PixelOffsetMode.HighQuality;
        attributes.SetWrapMode(WrapMode.TileFlipXY);
        graphics.DrawImage(source,new Rectangle(0,0,size,size),0,0,source.Width,source.Height,GraphicsUnit.Pixel,attributes);
      }
      using(var stream=new MemoryStream()) {bitmap.Save(stream,ImageFormat.Png);return stream.ToArray();}
    }
  }
  public static int Main(string[] args) {
    if(args.Length!=2 && args.Length!=3) {Console.Error.WriteLine("Usage: IconBuilder master.png output.ico [web-icons-directory]");return 1;}
    try {
      var sizes=new[]{16,24,32,48,64,128,256};var images=new List<byte[]>();
      using(var source=Image.FromFile(args[0])) {
        if(source.RawFormat.Guid!=ImageFormat.Png.Guid || source.Width!=source.Height || source.Width<256 || source.Width>8192)
          throw new ArgumentException("Icon master must be a square PNG between 256 and 8192 pixels.");
        foreach(var size in sizes)images.Add(Draw(source,size));
        if(args.Length==3) {
          Directory.CreateDirectory(args[2]);
          foreach(var size in new[]{32,192,512})File.WriteAllBytes(Path.Combine(args[2],"icon-"+size+".png"),Draw(source,size));
        }
      }
      using(var writer=new BinaryWriter(File.Create(args[1]))) {
        writer.Write((ushort)0);writer.Write((ushort)1);writer.Write((ushort)sizes.Length);int offset=6+sizes.Length*16;
        for(int i=0;i<sizes.Length;i++) {writer.Write((byte)(sizes[i]==256?0:sizes[i]));writer.Write((byte)(sizes[i]==256?0:sizes[i]));writer.Write((byte)0);writer.Write((byte)0);writer.Write((ushort)1);writer.Write((ushort)32);writer.Write(images[i].Length);writer.Write(offset);offset+=images[i].Length;}
        foreach(var image in images)writer.Write(image);
      }
      return 0;
    } catch(Exception error) {Console.Error.WriteLine(error.Message);return 2;}
  }
}
