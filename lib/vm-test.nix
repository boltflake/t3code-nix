# The server module in a NixOS VM: a lingering user's t3code-server starts
# at boot and answers on its port, and the installed t3 refuses upstream's
# service. With usage data off, the server starts with
# T3CODE_TELEMETRY_ENABLED=false; a switch that turns it back on keeps the
# running server as it was, and a restart starts it without the variable.
# Not among the flake's checks, which CI builds without KVM; run it with
#
#   nix build .#legacyPackages.x86_64-linux.vmTests.server -L
{ pkgs, self }:
pkgs.testers.runNixOSTest {
  name = "t3code-server";
  nodes.machine = {
    imports = [ self.nixosModules.default ];
    users.users.alice = {
      isNormalUser = true;
      linger = true;
    };
    programs.t3code.server = {
      enable = true;
      users = [ "alice" ];
    };
    programs.t3code.telemetry.enable = pkgs.lib.mkDefault false;
    environment.systemPackages = [
      pkgs.curl
      pkgs.sqlite
    ];
    virtualisation.memorySize = 2048;
    # The same with a changed unit, to switch to.
    specialisation.changed.configuration.programs.t3code = {
      server.logLevel = "Debug";
      telemetry.enable = true;
    };
  };
  testScript = ''
    # Lingering: alice's manager, and with it the server, start at boot.
    machine.wait_for_unit("user@1000.service")
    machine.wait_for_unit("t3code-server.service", "alice")
    machine.wait_for_open_port(3773)
    # 503 until it is serving.
    machine.wait_until_succeeds("curl -sf -o /dev/null http://127.0.0.1:3773/", timeout=120)
    # Only on this machine by default.
    machine.succeed("ss -ltn | grep -q '127.0.0.1:3773 '")
    def user(cmd):
        return machine.succeed(f"systemctl --user -M alice@ {cmd}").strip()

    # As if a different version had run before, and from a desktop session
    # (which sets these in the user manager): a restart copies the database
    # first, the server's login shell still gets NixOS's environment, and
    # the stop counts as clean.
    machine.succeed("echo 0.0.1 > /home/alice/.t3/t3code-nix-backups/last-version")
    user("set-environment __NIXOS_SET_ENVIRONMENT_DONE=1 __ETC_PROFILE_DONE=1 __HM_SESS_VARS_SOURCED=1")
    # Read while stopped: a start resets Result.
    user("stop t3code-server.service")
    assert user("show -p Result --value t3code-server.service") == "success"
    user("start t3code-server.service")
    pid = user("show -p MainPID --value t3code-server.service")
    machine.fail(f"tr '\\0' '\\n' < /proc/{pid}/environ | grep -q '^__\\(NIXOS_SET_ENVIRONMENT\\|ETC_PROFILE\\|HM_SESS_VARS\\)'")
    machine.succeed("sqlite3 /home/alice/.t3/t3code-nix-backups/statev2-0.0.1-*.sqlite 'pragma integrity_check' | grep -qx ok")
    machine.wait_until_succeeds("curl -sf -o /dev/null http://127.0.0.1:3773/", timeout=120)

    def telemetry(pid):
        env = machine.succeed(f"tr '\\0' '\\n' < /proc/{pid}/environ").splitlines()
        return [l for l in env if l.startswith("T3CODE_TELEMETRY_ENABLED=")]
    assert telemetry(pid) == ["T3CODE_TELEMETRY_ENABLED=false"], telemetry(pid)

    # A rebuild that changes the unit (and turns usage data back on) leaves
    # the running server alone; a restart starts it without the variable.
    machine.succeed("/run/current-system/specialisation/changed/bin/switch-to-configuration test")
    assert user("show -p MainPID --value t3code-server.service") == pid
    assert telemetry(pid) == ["T3CODE_TELEMETRY_ENABLED=false"], telemetry(pid)
    user("restart t3code-server.service")
    machine.wait_until_succeeds("curl -sf -o /dev/null http://127.0.0.1:3773/", timeout=120)
    pid = user("show -p MainPID --value t3code-server.service")
    assert telemetry(pid) == [], telemetry(pid)
    out = machine.fail("su - alice -c 't3 service install' 2>&1")
    assert "programs.t3code-nix.server" in out, out
  '';
}
