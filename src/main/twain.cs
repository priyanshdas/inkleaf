// SPDX-License-Identifier: GPL-3.0-or-later
// TWAIN for Inkleaf's scanner support on Windows. Many older scanners and
// all-in-ones (HP's LaserJet M1005, for one) only come with a TWAIN driver,
// and most of those are 32-bit, so this is compiled by whichever PowerShell
// matches the driver: the 32-bit one for twain_32.dll, the 64-bit one for
// TWAINDSM.dll.
//
// Kept to C# 5, the version Windows PowerShell's Add-Type compiles.
//
// List() prints one "SOURCE<tab>1 or 0 (which manager)<tab>name" line per scanner.
// Scan() saves page-1.bmp, page-2.bmp… (one from the glass, every sheet in
// the feeder) and prints "OK<tab>count", or prints "ERR<tab>reason" (cancel,
// busy, offline, nopaper, nofeeder, noduplex, failed).

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Inkleaf
{
    [StructLayout(LayoutKind.Sequential, Pack = 2, CharSet = CharSet.Ansi)]
    public class TwIdentity
    {
        public uint Id;
        public ushort MajorNum;
        public ushort MinorNum;
        public ushort Language;
        public ushort Country;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 34)] public string Info = "";
        public ushort ProtocolMajor;
        public ushort ProtocolMinor;
        public uint SupportedGroups;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 34)] public string Manufacturer = "";
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 34)] public string ProductFamily = "";
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 34)] public string ProductName = "";
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    public class TwUserInterface { public ushort ShowUI; public ushort ModalUI; public IntPtr hParent; }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    public class TwEvent { public IntPtr pEvent; public ushort TWMessage; }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    public class TwPendingXfers { public ushort Count; public uint EOJ; }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    public class TwCapability { public ushort Cap; public ushort ConType; public IntPtr hContainer; }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    public class TwStatus { public ushort ConditionCode; public ushort Data; }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    public struct TwOneValue { public ushort ItemType; public uint Item; }

    // The same entry point in the two places Windows keeps it.
    static class Legacy
    {
        [DllImport("twain_32.dll", EntryPoint = "DSM_Entry")] public static extern ushort Parent(TwIdentity origin, IntPtr zero, uint dg, ushort dat, ushort msg, ref IntPtr hwnd);
        [DllImport("twain_32.dll", EntryPoint = "DSM_Entry")] public static extern ushort Ident(TwIdentity origin, IntPtr zero, uint dg, ushort dat, ushort msg, [In, Out] TwIdentity data);
        [DllImport("twain_32.dll", EntryPoint = "DSM_Entry")] public static extern ushort Call(TwIdentity origin, TwIdentity dest, uint dg, ushort dat, ushort msg, IntPtr data);
        [DllImport("twain_32.dll", EntryPoint = "DSM_Entry")] public static extern ushort Native(TwIdentity origin, TwIdentity dest, uint dg, ushort dat, ushort msg, ref IntPtr handle);
    }

    static class Modern
    {
        [DllImport("TWAINDSM.dll", EntryPoint = "DSM_Entry")] public static extern ushort Parent(TwIdentity origin, IntPtr zero, uint dg, ushort dat, ushort msg, ref IntPtr hwnd);
        [DllImport("TWAINDSM.dll", EntryPoint = "DSM_Entry")] public static extern ushort Ident(TwIdentity origin, IntPtr zero, uint dg, ushort dat, ushort msg, [In, Out] TwIdentity data);
        [DllImport("TWAINDSM.dll", EntryPoint = "DSM_Entry")] public static extern ushort Call(TwIdentity origin, TwIdentity dest, uint dg, ushort dat, ushort msg, IntPtr data);
        [DllImport("TWAINDSM.dll", EntryPoint = "DSM_Entry")] public static extern ushort Native(TwIdentity origin, TwIdentity dest, uint dg, ushort dat, ushort msg, ref IntPtr handle);
    }

    public static class Twain
    {
        const uint DG_CONTROL = 1, DG_IMAGE = 2;
        const ushort DAT_CAPABILITY = 1, DAT_EVENT = 2, DAT_IDENTITY = 3, DAT_PARENT = 4, DAT_PENDINGXFERS = 5,
            DAT_STATUS = 8, DAT_USERINTERFACE = 9, DAT_IMAGENATIVEXFER = 0x0104;
        const ushort MSG_GET = 1, MSG_GETFIRST = 4, MSG_GETNEXT = 5, MSG_SET = 6, MSG_RESET = 7,
            MSG_XFERREADY = 0x0101, MSG_CLOSEDSREQ = 0x0102, MSG_CLOSEDSOK = 0x0103,
            MSG_OPENDSM = 0x0301, MSG_CLOSEDSM = 0x0302, MSG_OPENDS = 0x0401, MSG_CLOSEDS = 0x0402,
            MSG_DISABLEDS = 0x0501, MSG_ENABLEDS = 0x0502, MSG_PROCESSEVENT = 0x0601, MSG_ENDXFER = 0x0701;
        const ushort RC_SUCCESS = 0, RC_FAILURE = 1, RC_CHECKSTATUS = 2, RC_CANCEL = 3, RC_DSEVENT = 4, RC_XFERDONE = 6, RC_ENDOFLIST = 7;
        const ushort CAP_XFERCOUNT = 0x0001, CAP_FEEDERENABLED = 0x1002, CAP_AUTOFEED = 0x1007, CAP_DUPLEXENABLED = 0x1013, ICAP_PIXELTYPE = 0x0101, ICAP_XRESOLUTION = 0x1118, ICAP_YRESOLUTION = 0x1119;
        const ushort TWON_ONEVALUE = 5, TWTY_INT16 = 1, TWTY_UINT16 = 4, TWTY_BOOL = 6, TWTY_FIX32 = 7;

        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint exStyle, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
        [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool PeekMessageW(IntPtr msg, IntPtr hwnd, uint min, uint max, uint remove);
        [DllImport("user32.dll")] static extern bool TranslateMessage(IntPtr msg);
        [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(IntPtr msg);
        [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
        [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr mem);
        [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr mem);
        [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr mem);
        [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr mem);

        static bool legacy;
        static TwIdentity app;
        static IntPtr window;

        static ushort Parent(ushort msg) { return legacy ? Legacy.Parent(app, IntPtr.Zero, DG_CONTROL, DAT_PARENT, msg, ref window) : Modern.Parent(app, IntPtr.Zero, DG_CONTROL, DAT_PARENT, msg, ref window); }
        static ushort Ident(ushort msg, TwIdentity data) { return legacy ? Legacy.Ident(app, IntPtr.Zero, DG_CONTROL, DAT_IDENTITY, msg, data) : Modern.Ident(app, IntPtr.Zero, DG_CONTROL, DAT_IDENTITY, msg, data); }
        static ushort Call(TwIdentity source, uint dg, ushort dat, ushort msg, IntPtr data) { return legacy ? Legacy.Call(app, source, dg, dat, msg, data) : Modern.Call(app, source, dg, dat, msg, data); }
        static ushort NativeXfer(TwIdentity source, ref IntPtr handle) { return legacy ? Legacy.Native(app, source, DG_IMAGE, DAT_IMAGENATIVEXFER, MSG_GET, ref handle) : Modern.Native(app, source, DG_IMAGE, DAT_IMAGENATIVEXFER, MSG_GET, ref handle); }

        /// Calls with a structure: copies it out, makes the call, copies back what the scanner filled in.
        static ushort CallWith(TwIdentity source, uint dg, ushort dat, ushort msg, object data)
        {
            IntPtr p = Marshal.AllocHGlobal(Marshal.SizeOf(data));
            try
            {
                Marshal.StructureToPtr(data, p, false);
                ushort rc = Call(source, dg, dat, msg, p);
                Marshal.PtrToStructure(p, data);
                return rc;
            }
            finally { Marshal.FreeHGlobal(p); }
        }

        static void Open(bool useLegacy)
        {
            legacy = useLegacy;
            app = new TwIdentity();
            app.MajorNum = 3; app.MinorNum = 1; app.Language = 2; app.Country = 1;
            app.Info = "Inkleaf"; app.ProtocolMajor = 2; app.ProtocolMinor = 3;
            app.SupportedGroups = DG_CONTROL | DG_IMAGE;
            app.Manufacturer = "EPD"; app.ProductFamily = "Inkleaf"; app.ProductName = "Inkleaf";
            // a real (hidden) window: some drivers hang their own windows off it
            window = CreateWindowExW(0, "STATIC", "Inkleaf scanning", 0, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            if (Parent(MSG_OPENDSM) != RC_SUCCESS) throw new Exception("dsm");
        }

        static void Close()
        {
            try { Parent(MSG_CLOSEDSM); } catch { }
            if (window != IntPtr.Zero) DestroyWindow(window);
        }

        public static void List(bool useLegacy)
        {
            Open(useLegacy);
            try
            {
                TwIdentity source = new TwIdentity();
                ushort rc = Ident(MSG_GETFIRST, source);
                while (rc == RC_SUCCESS)
                {
                    Console.WriteLine("SOURCE\t" + (legacy ? "1" : "0") + "\t" + source.ProductName);
                    source = new TwIdentity();
                    rc = Ident(MSG_GETNEXT, source);
                }
            }
            finally { Close(); }
        }

        static TwIdentity Find(string name)
        {
            TwIdentity source = new TwIdentity();
            ushort rc = Ident(MSG_GETFIRST, source);
            while (rc == RC_SUCCESS)
            {
                if (source.ProductName == name) return source;
                source = new TwIdentity();
                rc = Ident(MSG_GETNEXT, source);
            }
            return null;
        }

        static ushort Condition(TwIdentity source)
        {
            TwStatus status = new TwStatus();
            CallWith(source, DG_CONTROL, DAT_STATUS, MSG_GET, status);
            return status.ConditionCode;
        }

        static string Reason(ushort condition)
        {
            switch (condition)
            {
                case 4: return "busy";       // too many connections: something else has it
                case 3: case 23: return "offline";
                case 20: return "nopaper";  // a jam; the closest plain message
                default: return "failed";
            }
        }

        /// Sets one value; a driver that won't take it keeps its own, which is fine.
        static ushort Set(TwIdentity source, ushort cap, ushort type, uint value)
        {
            IntPtr container = GlobalAlloc(0x42, (UIntPtr)Marshal.SizeOf(typeof(TwOneValue)));
            try
            {
                TwOneValue one = new TwOneValue();
                one.ItemType = type; one.Item = value;
                Marshal.StructureToPtr(one, GlobalLock(container), false);
                GlobalUnlock(container);
                TwCapability c = new TwCapability();
                c.Cap = cap; c.ConType = TWON_ONEVALUE; c.hContainer = container;
                return CallWith(source, DG_CONTROL, DAT_CAPABILITY, MSG_SET, c);
            }
            finally { GlobalFree(container); }
        }

        /// A DIB from the driver, written out as a .bmp file.
        static void SaveDib(IntPtr dib, string path)
        {
            IntPtr p = GlobalLock(dib);
            try
            {
                int headerSize = Marshal.ReadInt32(p, 0);
                int width = Marshal.ReadInt32(p, 4);
                int height = Math.Abs(Marshal.ReadInt32(p, 8));
                int bits = Marshal.ReadInt16(p, 14);
                int compression = Marshal.ReadInt32(p, 16);
                int imageSize = Marshal.ReadInt32(p, 20);
                int colours = Marshal.ReadInt32(p, 32);
                if (colours == 0 && bits <= 8) colours = 1 << bits;
                int palette = colours * 4 + (compression == 3 ? 12 : 0);
                int stride = ((width * bits + 31) / 32) * 4;
                if (imageSize == 0 || compression == 0) imageSize = stride * height;
                int dibBytes = headerSize + palette + imageSize;
                long available = (long)GlobalSize(dib).ToUInt64();
                if (available > 0 && dibBytes > available) dibBytes = (int)available;

                byte[] data = new byte[dibBytes];
                Marshal.Copy(p, data, 0, dibBytes);
                using (FileStream file = File.Create(path))
                using (BinaryWriter w = new BinaryWriter(file))
                {
                    w.Write((byte)'B'); w.Write((byte)'M');
                    w.Write(14 + dibBytes);
                    w.Write(0);
                    w.Write(14 + headerSize + palette);
                    w.Write(data);
                }
            }
            finally { GlobalUnlock(dib); }
        }

        public static void Scan(bool useLegacy, string name, int dpi, string color, string source, string dir)
        {
            Open(useLegacy);
            TwIdentity ds = null;
            bool opened = false, enabled = false, feeder = source != "glass";
            int saved = 0;
            IntPtr msg = Marshal.AllocHGlobal(64);
            try
            {
                ds = Find(name);
                if (ds == null) { Console.WriteLine("ERR\toffline"); return; }
                if (Ident(MSG_OPENDS, ds) != RC_SUCCESS) { Console.WriteLine("ERR\t" + Reason(Condition(null))); return; }
                opened = true;

                // the glass, or the feeder (and both sides of each sheet)
                if (feeder)
                {
                    if (Set(ds, CAP_FEEDERENABLED, TWTY_BOOL, 1) != RC_SUCCESS) { Console.WriteLine("ERR\tnofeeder"); return; }
                    Set(ds, CAP_AUTOFEED, TWTY_BOOL, 1);
                    if (source == "duplex" && Set(ds, CAP_DUPLEXENABLED, TWTY_BOOL, 1) != RC_SUCCESS) { Console.WriteLine("ERR\tnoduplex"); return; }
                    Set(ds, CAP_XFERCOUNT, TWTY_INT16, 0xFFFF); // -1: as many as there are
                }
                else
                {
                    Set(ds, CAP_FEEDERENABLED, TWTY_BOOL, 0);
                    Set(ds, CAP_XFERCOUNT, TWTY_INT16, 1);
                }
                Set(ds, ICAP_PIXELTYPE, TWTY_UINT16, (uint)(color == "bw" ? 0 : color == "gray" ? 1 : 2));
                Set(ds, ICAP_XRESOLUTION, TWTY_FIX32, (uint)dpi);
                Set(ds, ICAP_YRESOLUTION, TWTY_FIX32, (uint)dpi);

                // ask for no window of its own; some drivers show one anyway
                TwUserInterface ui = new TwUserInterface();
                ui.ShowUI = 0; ui.ModalUI = 0; ui.hParent = window;
                ushort rc = CallWith(ds, DG_CONTROL, DAT_USERINTERFACE, MSG_ENABLEDS, ui);
                if (rc == RC_CHECKSTATUS) { ui.ShowUI = 1; rc = CallWith(ds, DG_CONTROL, DAT_USERINTERFACE, MSG_ENABLEDS, ui); }
                if (rc != RC_SUCCESS) { Console.WriteLine("ERR\t" + (feeder ? "nopaper" : Reason(Condition(ds)))); return; }
                enabled = true;

                // the driver tells us through window messages when pages are ready
                DateTime deadline = DateTime.UtcNow.AddMinutes(15);
                while (DateTime.UtcNow < deadline)
                {
                    if (!PeekMessageW(msg, IntPtr.Zero, 0, 0, 1)) { Thread.Sleep(10); continue; }
                    TwEvent ev = new TwEvent();
                    ev.pEvent = msg;
                    if (CallWith(ds, DG_CONTROL, DAT_EVENT, MSG_PROCESSEVENT, ev) != RC_DSEVENT)
                    {
                        TranslateMessage(msg);
                        DispatchMessageW(msg);
                        continue;
                    }
                    if (ev.TWMessage == MSG_CLOSEDSREQ || ev.TWMessage == MSG_CLOSEDSOK) { Done(saved, "cancel"); return; }
                    if (ev.TWMessage != MSG_XFERREADY) continue;

                    // one page after another, for as long as the driver has more
                    while (true)
                    {
                        IntPtr dib = IntPtr.Zero;
                        rc = NativeXfer(ds, ref dib);
                        TwPendingXfers pending = new TwPendingXfers();
                        if (rc == RC_XFERDONE && dib != IntPtr.Zero)
                        {
                            saved++;
                            try { SaveDib(dib, Path.Combine(dir, "page-" + saved + ".bmp")); } finally { GlobalFree(dib); }
                            CallWith(ds, DG_CONTROL, DAT_PENDINGXFERS, MSG_ENDXFER, pending);
                            if (feeder && pending.Count != 0) continue;
                            if (pending.Count != 0) CallWith(ds, DG_CONTROL, DAT_PENDINGXFERS, MSG_RESET, new TwPendingXfers());
                            Done(saved, null);
                            return;
                        }
                        if (dib != IntPtr.Zero) GlobalFree(dib);
                        string why = rc == RC_CANCEL ? "cancel" : feeder && saved == 0 ? "nopaper" : Reason(Condition(ds));
                        CallWith(ds, DG_CONTROL, DAT_PENDINGXFERS, MSG_ENDXFER, pending);
                        if (pending.Count != 0) CallWith(ds, DG_CONTROL, DAT_PENDINGXFERS, MSG_RESET, new TwPendingXfers());
                        Done(saved, why);
                        return;
                    }
                }
                Done(saved, "offline");
            }
            finally
            {
                if (enabled) CallWith(ds, DG_CONTROL, DAT_USERINTERFACE, MSG_DISABLEDS, new TwUserInterface());
                if (opened) Ident(MSG_CLOSEDS, ds);
                Marshal.FreeHGlobal(msg);
                Close();
            }
        }

        /// Pages already scanned are kept even if a later one went wrong (the feeder ran out, say).
        static void Done(int saved, string problem)
        {
            if (saved > 0) Console.WriteLine("OK\t" + saved);
            else Console.WriteLine("ERR\t" + (problem ?? "failed"));
        }
    }
}
