CLASS zcl_osd_se80 DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES zif_osd_transaction.
  PRIVATE SECTION.
    DATA mo_workbench TYPE REF TO zcl_osd_workbench.
ENDCLASS.
CLASS zcl_osd_se80 IMPLEMENTATION.
  METHOD zif_osd_transaction~roll_in.
    CREATE OBJECT mo_workbench EXPORTING iv_mode = `SE80`.
    mo_workbench->zif_osd_transaction~roll_in( iv_state ).
  ENDMETHOD.
  METHOD zif_osd_transaction~roll_out.
    rv_state = mo_workbench->zif_osd_transaction~roll_out( ).
  ENDMETHOD.
  METHOD zif_osd_transaction~pbo.
    mo_workbench->zif_osd_transaction~pbo( ).
  ENDMETHOD.
  METHOD zif_osd_transaction~title.
    rv_title = `Object Navigator`.
  ENDMETHOD.
  METHOD zif_osd_transaction~message.
    rv_message = mo_workbench->zif_osd_transaction~message( ).
  ENDMETHOD.
ENDCLASS.
